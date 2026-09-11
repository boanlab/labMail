# LabMail

[![CI](https://github.com/boanlab/labMail/actions/workflows/ci.yml/badge.svg)](https://github.com/boanlab/labMail/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One Google Workspace mailbox, split into separate inboxes by purpose.**

A shared mailbox collects everything an organization receives in one place,
which keeps correspondence continuous as people come and go but leaves every
purpose piled together: support, enquiries, notices, applications. Gmail offers
no way to partition a single mailbox.

LabMail is that partition. It sits in front of one Workspace account. Each
address — `support@`, `contact@`, `admin@` — gets its own inbox, its own read
and archive state, its own rules, and sends under its own name. Receiving,
sending and storage all stay with Gmail; there is no separate mail server, no
forwarding service, and no outbound relay to run.

### What it is for

Separating one mailbox by **purpose**, so a person working the support queue is
not reading through enquiries and automated notices to find it.

It is not a way to give people mailboxes without accounts. Google Workspace is
licensed per person, not per address, and an address is not a licence: aliases
and groups are exactly what Google provides for role addresses. Whoever signs
in to LabMail should be someone your organization already licenses. Where each
person needs their own mail, give them their own Workspace account — that is
what accounts are for, and it is the only arrangement with real isolation.

> **Read [the security model](docs/security-model.md) before deploying.**
> Separation between members is enforced by this application's queries, not by
> Google. It is a presentation layer over one mailbox, not an access-control
> boundary between accounts — anyone who can reach the underlying Workspace
> account or the database sees everything. Where genuine per-user isolation is
> required, use separate accounts.

---

## How it works

```
              MX ─────▶ Google (default routing → shared mailbox)
                                    │
                                    │ Gmail API
                                    ▼
                    ┌───────────────────────────────┐
                    │  sync worker                  │
                    │  users.history.list (delta)   │
                    │  ownership resolution         │
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │  SQLite                       │
                    │  messages                     │
                    │  message_owners  ◀── access   │
                    │                      control  │
                    └───────────────┬───────────────┘
                                    ▼
 browser ──▶ LabMail session ──▶ queries scoped to the session alias
```

**Isolation does not use Gmail search queries.** A sync worker resolves who each
message belongs to when it arrives and records that in `message_owners`. Every
read is a SQL join on the session alias. Nothing a client sends participates in
scoping, and the Gmail API is touched only by the sync worker and the send path.

Outgoing `From` comes from the server-side session. Whatever a compose request
contains, a member can only send as themselves.

See [the security model](docs/security-model.md) for the reasoning.

## Features

- **Conversation view** — threads expand in place, quoted history folds away
- **Triage** — multi-select with bulk actions, and keyboard shortcuts throughout
  (`j`/`k`, `e` archive, `#` trash, `r` reply, `c` compose, `?` for the rest)
- **Compose** — a formatting toolbar (bold, lists, links, quotes), recipient
  autocomplete drawn from your own correspondence, drag-and-drop attachments,
  a per-member signature, and drafts saved to Gmail, so an unfinished message is
  waiting on any device
- **Undo send** — messages are held briefly before they go out, and the window
  is configurable
- **Per-member Drive folder** — files each member alone can reach, attachable to
  mail as a link, which is also how anything over Gmail's 25MB limit is sent
- **Search, filters, pagination** — unread and starred filters, date grouping
- **Spam is visible** — Gmail's spam folder is reachable, with one-click recovery
  for mail it misclassified
- **Self-service signup with admin approval** — approval is also when the
  member's address is created and starts delivering
- **Unassigned queue** — mail whose recipient could not be resolved waits for an
  admin rather than being guessed at
- **Configuration in the browser** — no Google credentials in environment files;
  OAuth consent completes in the UI
- **Korean and English** — switchable from the toolbar; server messages follow
  the same choice
- **Light, dark, or system** — an explicit choice that overrides the operating
  system and persists per browser
- **Mail clients** — SMTP submission and IMAP in front of the same per-member
  view, so Thunderbird, Apple Mail or a phone works with per-device passwords
- **More than one domain** — addresses may be issued under a Workspace's
  secondary domains, and the same local part is free under each
- **Single container** — sync runs in-process; SQLite on one volume


## Interface

- **Conversation view** — older messages in a thread collapse to one line, and
  quoted history folds away behind a toggle.
- **Compose** — a formatting toolbar, recipient autocomplete drawn from your own
  correspondence, drag-and-drop attachments and drafts saved to Gmail.
- **Keyboard** — `j`/`k` to move, `e` archive, `#` trash, `r` reply, `c` compose,
  `?` for the rest.
- **Members** — approving a signup fixes the address and makes it deliverable.
  Sending stays closed until an operator adds the send-as entry, which LabMail
  cannot create for itself.
- **System settings** — Google is configured here, not in environment files, and
  a numbered checklist links straight to the console pages each step needs.
- **Narrow screens** — one pane at a time, with back navigation and a drawer for
  the sidebar.
- **Dark mode** — follows the operating system; Korean and English switch from
  the toolbar.

## Quick start

```bash
git clone https://github.com/boanlab/labMail.git
cd LabMail
cp .env.example .env
echo "ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env
docker compose up -d --build
```

Open `http://<host-ip>:8000` and sign in with the credentials from `.env`.
Google is configured afterward, from the admin UI.

To evaluate the interface before connecting Google:

```bash
docker compose exec labmail node --experimental-strip-types \
  src/scripts/seed-demo.ts admin
```

That inserts sample mail. It refuses to run once Google is connected, so it
cannot pollute a real mailbox. Remove it later with `-- --clear`.

Full instructions: [docs/deployment.md](docs/deployment.md).

## Requirements

- Docker with Compose, or Node 22+ for a local run
- A Google Workspace domain **with admin console access**

The second is not negotiable. LabMail depends on domain-level default routing,
the `X-Gm-Original-To` header, and DKIM. A personal Gmail account cannot be the
MX for a custom domain, and a centrally administered university or corporate
domain usually will not grant these settings.

## Limits worth knowing before you commit

| | |
|---|---|
| **Sending is capped per account** | One Workspace account's daily recipient limit is divided among all members. Ten members on a 2,000/day cap is 200 each. |
| **Storage is shared** | So is the Gmail API rate limit. |
| **Isolation is application-level** | A missing query join exposes the whole mailbox. See the [security model](docs/security-model.md). |
| **The shared password must never be shared** | Anyone who signs in to Gmail directly sees everyone's mail. No code prevents this. |
| **An address is not a licence** | Workspace is licensed per person. Splitting a mailbox by purpose does not change how many people use it, and everyone who signs in is one of them. |
| **Sending needs one manual step per member** | The API that registers a send address is restricted to service accounts with domain-wide authority, so an operator adds each member's once. LabMail refuses to send until it exists, rather than letting mail go out under the shared account's name. |
| **Deletion is per member** | Permanent deletion needs a Gmail scope this application does not request. Removing a message hides it from that member; Gmail empties its own Trash on schedule. |
| **One container, no redundancy** | SQLite on one volume, sync in-process. A restart pauses sync until it comes back. |

## Development

```bash
npm install
cp .env.example .env
echo "ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env
npm run dev

npm run typecheck  # type check
npm test           # unit and integration tests
```

Node runs the TypeScript directly via type stripping, so there is no build step.
See [CONTRIBUTING.md](CONTRIBUTING.md) for what that implies.

## Documentation

| | |
|---|---|
| [Security model](docs/security-model.md) | How isolation is enforced, and what it does not cover |
| [Deployment](docs/deployment.md) | Docker, Google setup, monitoring, backups |
| [Mail clients](docs/mail-clients.md) | SMTP and IMAP, and the TLS proxy in front of them |
| [Configuration](docs/configuration.md) | Environment and runtime settings |
| [Contributing](CONTRIBUTING.md) | Development setup and conventions |

## Status

Running against a live Google Workspace account. Sync, sending, provisioning,
attachments, Drive links, the OAuth flow and both mail protocols have all been
exercised with real credentials and a real mail client, alongside 250 unit
tests covering ownership resolution, per-member state, alias isolation, the
rule engine, sign-in throttling, MIME assembly, HTML sanitisation, route
authorisation, and the SMTP and IMAP surfaces.

## License

[MIT](LICENSE)
