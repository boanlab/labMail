-- LabMail schema.
--
-- Access-control boundary: `message_owners`. Reads reach a message only by
-- joining it on the session alias.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Accounts. Independent of Google identity. ───────────────────────────────
-- Signup lands as 'pending'; approval provisions the alias and activates.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  -- Domain the member asked for, when the deployment issues more than one.
  -- NULL before any domain is configured.
  alias_domain  TEXT,
  -- Requested local part, e.g. "hong". Composed with the domain at approval.
  -- Unique per domain rather than on its own: with a second domain configured,
  -- hong@a and hong@b are different people.
  alias_local   TEXT,
  -- Full alias, composed at approval. NULL while pending, and for an operator
  -- account with no mailbox.
  alias_email   TEXT    UNIQUE,
  password_hash TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active', 'deactivated')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  -- Workspace side (Group + send-as). Separate from `status` so a failed
  -- provisioning call stays visible and retryable.
  provisioned   INTEGER NOT NULL DEFAULT 0,
  provision_error TEXT,
  -- Appended to messages this member composes. HTML, sanitized on save.
  signature     TEXT,
  -- Drive folder that holds this member's files, created at approval.
  drive_folder_id TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  deactivated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_alias  ON users (alias_email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

-- ── Mirrored Gmail messages ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  gmail_id        TEXT    NOT NULL UNIQUE,
  gmail_thread_id TEXT    NOT NULL,
  -- Gmail addresses drafts by a separate id, needed to update, send or discard
  -- one. NULL for everything that is not a draft.
  gmail_draft_id  TEXT    UNIQUE,
  -- RFC822 Message-ID, needed to thread replies correctly.
  rfc822_id       TEXT,
  from_addr       TEXT    NOT NULL,
  from_name       TEXT,
  to_addrs        TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  cc_addrs        TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  reply_to        TEXT,
  subject         TEXT    NOT NULL DEFAULT '',
  snippet         TEXT    NOT NULL DEFAULT '',
  body_text       TEXT,
  body_html       TEXT,
  -- Gmail labels (INBOX, SENT, TRASH, UNREAD, ...) as JSON. Source of truth
  -- for mailbox placement.
  labels          TEXT    NOT NULL DEFAULT '[]',
  internal_date   INTEGER NOT NULL,               -- epoch ms, Gmail's ordering key
  has_attachments INTEGER NOT NULL DEFAULT 0,
  -- Headers ownership was resolved from. Kept for auditing a misroute.
  routing_headers TEXT    NOT NULL DEFAULT '{}',  -- JSON object
  synced_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_date   ON messages (internal_date DESC);

-- ── Ownership: the access-control table ─────────────────────────────────────
-- Many-to-many: Gmail deduplicates one message addressed to two members, but
-- it belongs to both. `alias` carries no foreign key so ownership outlives the
-- account.
CREATE TABLE IF NOT EXISTS message_owners (
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  alias      TEXT    NOT NULL,
  -- Evidence used: x-gm-original-to | delivered-to | to | cc | from | manual.
  source     TEXT    NOT NULL,
  assigned_at TEXT   NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_owners_alias ON message_owners (alias);

-- ── Per-member message state ────────────────────────────────────────────────
-- Read, starred and archived belong to a member, not to the mailbox. Two
-- members can own one message — mail from one to the other does exactly that —
-- and one of them reading it must not mark it read for the other.
--
-- Trash and Spam are deliberately absent: those are states of the shared
-- mailbox itself and stay on `messages.labels`, where Gmail put them.
CREATE TABLE IF NOT EXISTS message_state (
  message_id  INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  alias       TEXT    NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  is_starred  INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  -- Gone from LabMail for this member. Gmail keeps the message — permanent
  -- deletion needs a scope this app deliberately does not ask for — so this is
  -- what "delete" can honestly mean here: it stops being theirs to see, and
  -- Gmail removes it from the Trash on its own schedule.
  is_removed  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_state_alias ON message_state (alias);

-- ── Member-defined categories ───────────────────────────────────────────────
-- Not Gmail labels: one mailbox serves every member, so a Gmail label would be
-- visible to all of them. Scoping by alias keeps a category private to the
-- member who made it, the same way every other read is scoped.
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  alias      TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  color      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (alias, name)
);

CREATE INDEX IF NOT EXISTS idx_categories_alias ON categories (alias);

CREATE TABLE IF NOT EXISTS message_categories (
  message_id  INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_msgcat_category ON message_categories (category_id);

-- ── Member-defined rules ────────────────────────────────────────────────────
-- Evaluated once, when a message is first attributed to this member. Actions
-- only ever write the per-member tables above, so one member's rules can never
-- move, hide or mark another member's mail.
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY,
  alias      TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  match_type TEXT    NOT NULL DEFAULT 'all' CHECK (match_type IN ('all', 'any')),
  -- JSON: [{ "field": "from", "op": "contains", "value": "..." }, ...]
  conditions TEXT    NOT NULL,
  -- JSON: { "categoryId": 3, "read": true, "star": false, "archive": true }
  actions    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rules_alias ON rules (alias);

-- ── Audit log ───────────────────────────────────────────────────────────────
-- Separation between members is enforced by this application's queries rather
-- than by Google, so the record of who reached what is the only way to answer
-- the question afterwards. Reading one message is the event worth keeping;
-- listing a mailbox is not, and would drown the useful entries.
--
-- Deliberately holds no subjects and no bodies. It records that an actor
-- touched a message, identified by its Gmail id — a second copy of the mail,
-- under different access rules, would be a liability rather than a record.
CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY,
  at       TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Alias where there is one, username otherwise, NULL before sign-in.
  actor    TEXT,
  actor_id INTEGER,
  action   TEXT    NOT NULL,
  -- What was acted on: a Gmail id, an alias, a setting key.
  target   TEXT,
  -- Small JSON object. Never message content.
  detail   TEXT,
  ip       TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at    ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, at DESC);

-- ── Attachments. Metadata only; bytes fetched from Gmail on demand. ────────
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  gmail_att_id  TEXT    NOT NULL,
  filename      TEXT    NOT NULL,
  mime_type     TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

-- ── Incremental sync bookkeeping (single row) ───────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  last_history_id   TEXT,
  last_synced_at    TEXT,
  watch_expiration  INTEGER
);

INSERT OR IGNORE INTO sync_state (id) VALUES (1);

-- ── Sessions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- ── Runtime configuration ───────────────────────────────────────────────────
-- Google credentials, entered through the admin UI. Stored unencrypted: this
-- file already holds every message body, so it is the artifact to protect.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Sends held for the undo window ──────────────────────────────────────────
-- Gmail has no unsend: its "undo" is a delay before the message is handed over,
-- and this is the same. The assembled message waits here so a browser closing
-- does not cancel it, and a restart can pick it back up.
CREATE TABLE IF NOT EXISTS pending_sends (
  id         TEXT PRIMARY KEY,
  alias      TEXT NOT NULL,
  raw        TEXT NOT NULL,          -- base64url RFC 5322 message
  thread_id  TEXT,
  draft_id   TEXT,                   -- discarded once the send succeeds
  send_at    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_sends_due ON pending_sends (send_at);

-- ── Drive mirror ────────────────────────────────────────────────────────────
-- Ownership for files, playing the part `message_owners` plays for mail. A file
-- id arriving from a client is never passed to Drive without matching a row
-- here for the session alias.
--
-- Drive also carries the owner in the file's appProperties, so this table can
-- be rebuilt from Drive if the database is lost — something mail cannot do.
CREATE TABLE IF NOT EXISTS drive_files (
  file_id     TEXT PRIMARY KEY,
  alias       TEXT    NOT NULL,
  parent_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  is_folder   INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  synced_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drive_alias  ON drive_files (alias);
CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_files (parent_id);

-- IMAP needs a stable, monotonic UID per message per member mailbox, and a
-- UIDVALIDITY a client can compare against what it cached. Neither can be
-- derived from message ids, which are shared across members and mailboxes.
CREATE TABLE IF NOT EXISTS imap_mailboxes (
  alias        TEXT    NOT NULL,
  mailbox      TEXT    NOT NULL,
  uidvalidity  INTEGER NOT NULL,
  uidnext      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (alias, mailbox)
);

CREATE TABLE IF NOT EXISTS imap_uids (
  alias      TEXT    NOT NULL,
  mailbox    TEXT    NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  uid        INTEGER NOT NULL,
  PRIMARY KEY (alias, mailbox, message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS imap_uids_order
  ON imap_uids (alias, mailbox, uid);

-- Credentials for mail clients, one per device. Kept apart from the sign-in
-- password: a client stores its copy on disk and sends it on every connection,
-- and losing a laptop should cost one entry rather than the account.
CREATE TABLE IF NOT EXISTS app_passwords (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);

CREATE INDEX IF NOT EXISTS app_passwords_user ON app_passwords (user_id);
