import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const db = new Database(config.databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/**
 * Columns added after the initial schema. `CREATE TABLE IF NOT EXISTS` leaves
 * an existing database alone, so each is applied only when absent.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'messages', column: 'gmail_draft_id', definition: 'TEXT' },
  { table: 'users', column: 'signature', definition: 'TEXT' },
  { table: 'users', column: 'drive_folder_id', definition: 'TEXT' },
  { table: 'message_state', column: 'is_removed', definition: 'INTEGER NOT NULL DEFAULT 0' },
]

function applyAddedColumns(): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (columns.some((c) => c.name === column)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    console.log(`[db] added ${table}.${column}`)
  }
}

export function migrate(): void {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))
  applyAddedColumns()
}

// On import: modules prepare statements at load time. Idempotent.
migrate()

export interface MessageRow {
  id: number
  gmail_id: string
  gmail_thread_id: string
  gmail_draft_id: string | null
  rfc822_id: string | null
  from_addr: string
  from_name: string | null
  to_addrs: string
  cc_addrs: string
  subject: string
  snippet: string
  body_text: string | null
  body_html: string | null
  labels: string
  internal_date: number
  has_attachments: number
  /** JSON object. Carries the envelope recipient, which rules can match on. */
  routing_headers: string
}

const LABEL = (name: string) => `EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value = '${name}')`

// TRASH and SPAM coexist with INBOX/SENT, so ordinary views exclude both.
const NOT_TRASHED = `NOT ${LABEL('TRASH')}`
const NOT_SPAM = `NOT ${LABEL('SPAM')}`
const ORDINARY = `${NOT_TRASHED} AND ${NOT_SPAM}`

/**
 * Per-member state, defaulted where a sync has not written a row. LEFT JOIN, so
 * a missing row degrades to "unread, unstarred, in the inbox".
 */
const READ = `COALESCE(st.is_read, 0) = 1`
/** Deleted from this member's view. Excluded from every mailbox, including Trash. */
const REMOVED = `COALESCE(st.is_removed, 0) = 1`
const ARCHIVED = `COALESCE(st.is_archived, 0) = 1`
const STARRED = `COALESCE(st.is_starred, 0) = 1`

/**
 * Which side of the message this alias was on.
 *
 * Every member address resolves to one physical mailbox, so member-to-member
 * mail is self-delivery: one copy carrying SENT and INBOX at once. Labels alone
 * would put it in the sender's inbox as well as the recipient's.
 */
const RECEIVED = `o.source <> 'from'`   // x-gm-original-to | delivered-to | to | cc | manual
const AUTHORED = `o.source = 'from'`

export type Mailbox = 'inbox' | 'sent' | 'trash' | 'spam' | 'drafts' | 'archive' | 'category'

/**
 * Mailbox predicates.
 *
 * Inbox and Archive follow this member's own `is_archived` flag: the INBOX
 * label belongs to the shared mailbox, so clearing it would archive the message
 * for everyone. Seeded from the label on arrival, the member's alone after.
 *
 * Trash and Spam stay on the label — those really are mailbox states.
 */
const MAILBOX_FILTER: Record<Mailbox, string> = {
  inbox:   `NOT ${ARCHIVED} AND NOT ${LABEL('DRAFT')} AND ${ORDINARY}`,
  archive: `${ARCHIVED} AND NOT ${LABEL('DRAFT')} AND ${ORDINARY}`,
  sent:    `${LABEL('SENT')} AND ${ORDINARY}`,
  drafts:  `${LABEL('DRAFT')} AND ${NOT_TRASHED}`,
  trash:   LABEL('TRASH'),
  spam:    LABEL('SPAM'),
  // A category groups mail; it is not another place for it to be.
  category: `NOT ${LABEL('DRAFT')} AND ${ORDINARY}`,
}

/**
 * Mailboxes that mean a role, not merely a label. Drafts are absent: the DRAFT
 * label already scopes them and a draft cannot be received.
 */
const OWNER_ROLE: Partial<Record<Mailbox, string>> = {
  inbox: RECEIVED,
  archive: RECEIVED,
  sent: AUTHORED,
}

/** Restriction to one of this member's categories. The id is bound, not spliced. */
const IN_CATEGORY = `EXISTS (
  SELECT 1 FROM message_categories mc
  JOIN categories c ON c.id = mc.category_id
  WHERE mc.message_id = m.id AND c.alias = o.alias AND c.id = ?
)`

/**
 * One alias's mailbox page. `alias` originates in the server-side session, and
 * the `message_owners` join is the access-control boundary.
 */
export type MailboxFilter = 'all' | 'unread' | 'starred'

// Fixed predicates selected by whitelist, never interpolated from input.
const FILTER_CLAUSE: Record<MailboxFilter, string> = {
  all: '1 = 1',
  unread: `NOT ${READ}`,
  starred: STARRED,
}

/** Every read joins ownership and this member's own state for the message. */
const SCOPED_FROM = `
  FROM messages m
  JOIN message_owners o ON o.message_id = m.id
  LEFT JOIN message_state st ON st.message_id = m.id AND st.alias = o.alias
`

export function listMailbox(
  alias: string,
  mailbox: Mailbox,
  opts: { limit?: number; offset?: number; filter?: MailboxFilter; categoryId?: number } = {},
): MessageRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const scope = MAILBOX_FILTER[mailbox]
  const filter = FILTER_CLAUSE[opts.filter ?? 'all'] ?? FILTER_CLAUSE.all
  const role = OWNER_ROLE[mailbox] ? ` AND ${OWNER_ROLE[mailbox]}` : ''
  const inCategory = opts.categoryId ? ` AND ${IN_CATEGORY}` : ''
  const params: (string | number)[] = [alias]
  if (opts.categoryId) params.push(opts.categoryId)

  return db.prepare(`
    SELECT m.* ${SCOPED_FROM}
    WHERE o.alias = ? AND NOT ${REMOVED} AND ${scope} AND ${filter}${role}${inCategory}
    ORDER BY m.internal_date DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as MessageRow[]
}

/** Per-mailbox totals for the sidebar badges. */
export function mailboxCounts(alias: string): Record<string, number> {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN ${MAILBOX_FILTER.inbox} AND ${RECEIVED} THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN ${MAILBOX_FILTER.inbox} AND ${RECEIVED} AND NOT ${READ}
               THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN ${MAILBOX_FILTER.sent} AND ${AUTHORED} THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN ${MAILBOX_FILTER.archive} AND ${RECEIVED} THEN 1 ELSE 0 END) AS archive,
      SUM(CASE WHEN ${MAILBOX_FILTER.trash} THEN 1 ELSE 0 END) AS trash,
      SUM(CASE WHEN ${MAILBOX_FILTER.spam} THEN 1 ELSE 0 END) AS spam,
      SUM(CASE WHEN ${MAILBOX_FILTER.drafts} THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN ${ORDINARY} AND ${STARRED} THEN 1 ELSE 0 END) AS starred
    ${SCOPED_FROM}
    WHERE o.alias = ? AND NOT ${REMOVED}
  `).get(alias) as Record<string, number | null>

  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? 0]))
}

/**
 * This member's state for a message, seeded from the labels. Insert-only: a
 * re-sync must not undo their own read or archive.
 */
// Prepared on first use: migrate() runs during this module's initialisation,
// where a const declared below is still in its temporal dead zone.
let seedStateStmt: import('better-sqlite3').Statement | null = null

export function seedMessageState(messageId: number, alias: string, labels: string[]): void {
  seedStateStmt ??= db.prepare(`
    INSERT INTO message_state (message_id, alias, is_read, is_starred, is_archived)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (message_id, alias) DO NOTHING
  `)
  seedStateStmt.run(
    messageId,
    alias,
    labels.includes('UNREAD') ? 0 : 1,
    labels.includes('STARRED') ? 1 : 0,
    // Absent INBOX means it was already filed away elsewhere.
    labels.includes('INBOX') ? 0 : 1,
  )
}

/**
 * Whether every owner of the message has read it.
 *
 * Gmail holds one UNREAD label for a message two members may both own, so it
 * can only be cleared once neither of them is still waiting on it.
 */
export function allOwnersRead(messageId: number): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS unread
    FROM message_owners o
    LEFT JOIN message_state st ON st.message_id = o.message_id AND st.alias = o.alias
    WHERE o.message_id = ? AND COALESCE(st.is_read, 0) = 0
  `).get(messageId) as { unread: number }
  return row.unread === 0
}

/** This member's categories on a message. Scoped by alias, like every read. */
const categoryIdsStmt = db.prepare(`
  SELECT mc.category_id AS id
  FROM message_categories mc
  JOIN categories c ON c.id = mc.category_id
  WHERE mc.message_id = ? AND c.alias = ?
  ORDER BY c.position, c.id
`)

export function categoryIdsFor(messageId: number, alias: string): number[] {
  return (categoryIdsStmt.all(messageId, alias) as { id: number }[]).map((r) => r.id)
}

export type StateField = 'is_read' | 'is_starred' | 'is_archived' | 'is_removed'

/** Set one flag for one member. Ownership must already have been verified. */
export function setMessageState(
  messageId: number, alias: string, field: StateField, value: boolean,
): void {
  db.prepare(`
    INSERT INTO message_state (message_id, alias, ${field}, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (message_id, alias)
      DO UPDATE SET ${field} = excluded.${field}, updated_at = datetime('now')
  `).run(messageId, alias, value ? 1 : 0)
}

export function messageStateFor(messageId: number, alias: string): {
  read: boolean; starred: boolean; archived: boolean
} {
  const row = db.prepare(
    `SELECT is_read, is_starred, is_archived FROM message_state WHERE message_id = ? AND alias = ?`,
  ).get(messageId, alias) as
    | { is_read: number; is_starred: number; is_archived: number }
    | undefined
  return {
    read: row?.is_read === 1,
    starred: row?.is_starred === 1,
    archived: row?.is_archived === 1,
  }
}

/**
 * Give every (message, member) pair without one a state row, seeded from the
 * shared labels. A data backfill, so it runs after this module has loaded
 * rather than from migrate().
 */
export function backfillMessageState(): number {
  const missing = db.prepare(`
    SELECT o.message_id AS message_id, o.alias AS alias, m.labels AS labels
    FROM message_owners o
    JOIN messages m ON m.id = o.message_id
    WHERE NOT EXISTS (
      SELECT 1 FROM message_state st
      WHERE st.message_id = o.message_id AND st.alias = o.alias
    )
  `).all() as { message_id: number; alias: string; labels: string }[]

  db.transaction(() => {
    for (const row of missing) {
      seedMessageState(row.message_id, row.alias, JSON.parse(row.labels) as string[])
    }
  })()
  return missing.length
}

/** A draft this alias owns, addressed by its Gmail draft id. */
export function getDraftForAlias(alias: string, draftId: string): MessageRow | null {
  const row = db.prepare(`
    SELECT m.* FROM messages m
    JOIN message_owners o ON o.message_id = m.id
    WHERE o.alias = ? AND m.gmail_draft_id = ?
  `).get(alias, draftId) as MessageRow | undefined
  return row ?? null
}

/** One message, or null when this alias does not own it. */
export function getMessageForAlias(alias: string, gmailId: string): MessageRow | null {
  const row = db.prepare(`
    SELECT m.* ${SCOPED_FROM}
    WHERE o.alias = ? AND m.gmail_id = ? AND NOT ${REMOVED}
  `).get(alias, gmailId) as MessageRow | undefined
  return row ?? null
}

/** Thread messages this alias owns. */
export function getThreadForAlias(alias: string, threadId: string): MessageRow[] {
  return db.prepare(`
    SELECT m.* ${SCOPED_FROM}
    WHERE o.alias = ? AND m.gmail_thread_id = ? AND NOT ${REMOVED}
    ORDER BY m.internal_date ASC
  `).all(alias, threadId) as MessageRow[]
}

export function countUnread(alias: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n ${SCOPED_FROM}
    WHERE o.alias = ? AND NOT ${REMOVED}
      AND ${MAILBOX_FILTER.inbox} AND ${RECEIVED} AND NOT ${READ}
  `).get(alias) as { n: number }
  return row.n
}

/** Unattributed messages. Admin queue, not a member-facing view. */
export function listUnassigned(limit = 100): MessageRow[] {
  return db.prepare(`
    SELECT m.* FROM messages m
    WHERE NOT EXISTS (SELECT 1 FROM message_owners o WHERE o.message_id = m.id)
      -- Discarded mail is not waiting for a decision. Offering it for
      -- assignment is worse than hiding it: the queue accepts the choice and
      -- the message still does not appear, because every mailbox view excludes
      -- the Trash. Drafts and sent copies never belong to the queue either.
      AND NOT EXISTS (
        SELECT 1 FROM json_each(m.labels) WHERE value IN ('TRASH', 'DRAFT', 'SENT')
      )
    ORDER BY m.internal_date DESC
    LIMIT ?
  `).all(Math.min(limit, 500)) as MessageRow[]
}

/**
 * Hide everything this member has in the Trash. Per-member removal, not a Gmail
 * delete: that needs a scope this application does not request.
 */
export function emptyTrashFor(alias: string): number {
  const rows = db.prepare(`
    SELECT m.id AS id ${SCOPED_FROM}
    WHERE o.alias = ? AND NOT ${REMOVED} AND ${MAILBOX_FILTER.trash}
  `).all(alias) as { id: number }[]

  const mark = db.prepare(`
    INSERT INTO message_state (message_id, alias, is_removed, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT (message_id, alias)
      DO UPDATE SET is_removed = 1, updated_at = datetime('now')
  `)
  db.transaction(() => { for (const row of rows) mark.run(row.id, alias) })()
  return rows.length
}

export function activeAliases(): string[] {
  const rows = db.prepare(
    `SELECT alias_email FROM users WHERE status = 'active' AND alias_email IS NOT NULL`,
  ).all() as { alias_email: string }[]
  return rows.map((r) => r.alias_email)
}

export interface DriveRow {
  file_id: string
  alias: string
  parent_id: string
  name: string
  mime_type: string
  size_bytes: number
  is_folder: number
  modified_at: string | null
}

/**
 * A Drive item, but only if this alias owns it. The access-control boundary for
 * files: every Drive call takes its id from here rather than from the request.
 */
export function getDriveItemForAlias(alias: string, fileId: string): DriveRow | null {
  const row = db.prepare(
    `SELECT * FROM drive_files WHERE alias = ? AND file_id = ?`,
  ).get(alias, fileId) as DriveRow | undefined
  return row ?? null
}

/** Direct children of a folder this alias owns. */
export function listDriveChildren(alias: string, parentId: string): DriveRow[] {
  return db.prepare(`
    SELECT * FROM drive_files
    WHERE alias = ? AND parent_id = ?
    ORDER BY is_folder DESC, name COLLATE NOCASE
  `).all(alias, parentId) as DriveRow[]
}

/** Bytes this alias holds in Drive, for the usage display. */
export function driveUsage(alias: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM drive_files WHERE alias = ? AND is_folder = 0`,
  ).get(alias) as { total: number }
  return row.total
}

/**
 * Every alias ever issued, including departed members, so their mail keeps
 * resolving. Login rights are governed separately by `status`.
 */
/**
 * Operator addresses, which own mail sent to the shared mailbox itself. Active
 * only: a departed administrator stops receiving the account's own notices.
 */
export function adminAliases(): string[] {
  const rows = db.prepare(
    `SELECT alias_email FROM users
      WHERE is_admin = 1 AND status = 'active' AND alias_email IS NOT NULL`,
  ).all() as { alias_email: string }[]
  return rows.map((r) => r.alias_email)
}

export function allKnownAliases(): string[] {
  const rows = db.prepare(
    `SELECT alias_email FROM users
      WHERE status IN ('active', 'deactivated') AND alias_email IS NOT NULL`,
  ).all() as { alias_email: string }[]
  return rows.map((r) => r.alias_email)
}
