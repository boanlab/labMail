import { db, listMailbox, type Mailbox, type MessageRow } from '../db/index.ts'

export interface UidMessage {
  uid: number
  row: MessageRow
}

/**
 * Mailboxes exposed over IMAP. The SPECIAL-USE attribute is what lets a client
 * place a folder without matching on its name.
 */
export const IMAP_MAILBOXES: { name: string; mailbox: Mailbox; attribute: string }[] = [
  { name: 'INBOX', mailbox: 'inbox', attribute: '' },
  { name: 'Archive', mailbox: 'archive', attribute: '\\Archive' },
  { name: 'Sent', mailbox: 'sent', attribute: '\\Sent' },
  { name: 'Drafts', mailbox: 'drafts', attribute: '\\Drafts' },
  { name: 'Junk', mailbox: 'spam', attribute: '\\Junk' },
  { name: 'Trash', mailbox: 'trash', attribute: '\\Trash' },
]

export const mailboxByName = (name: string): Mailbox | null =>
  IMAP_MAILBOXES.find((m) => m.name.toLowerCase() === name.toLowerCase())?.mailbox ?? null

const readState = db.prepare(
  `SELECT uidvalidity, uidnext FROM imap_mailboxes WHERE alias = ? AND mailbox = ?`,
)
const createState = db.prepare(
  `INSERT INTO imap_mailboxes (alias, mailbox, uidvalidity, uidnext) VALUES (?, ?, ?, 1)`,
)
const bumpNext = db.prepare(
  `UPDATE imap_mailboxes SET uidnext = ? WHERE alias = ? AND mailbox = ?`,
)
const readUids = db.prepare(
  `SELECT message_id, uid FROM imap_uids WHERE alias = ? AND mailbox = ?`,
)
const assignUid = db.prepare(
  `INSERT OR IGNORE INTO imap_uids (alias, mailbox, message_id, uid) VALUES (?, ?, ?, ?)`,
)
const dropUid = db.prepare(
  `DELETE FROM imap_uids WHERE alias = ? AND mailbox = ? AND message_id = ?`,
)

export interface MailboxView {
  uidvalidity: number
  uidnext: number
  messages: UidMessage[]
}

/**
 * The mailbox as IMAP sees it, assigning UIDs to anything new.
 *
 * Ordered by UID, ascending with arrival rather than the newest-first the web
 * list uses: sequence numbers are positions in this order, and a client that
 * saw them shuffle would re-download the mailbox.
 *
 * A message that leaves loses its UID and earns a new one on return, which is
 * what tells a client it is not the message it cached.
 */
export const openMailbox = db.transaction((alias: string, mailbox: Mailbox): MailboxView => {
  let state = readState.get(alias, mailbox) as { uidvalidity: number; uidnext: number } | undefined
  if (!state) {
    // Seconds, not milliseconds: UIDVALIDITY is a 32-bit unsigned value.
    const uidvalidity = Math.floor(Date.now() / 1000)
    createState.run(alias, mailbox, uidvalidity)
    state = { uidvalidity, uidnext: 1 }
  }

  const rows = listMailbox(alias, mailbox, { limit: 200, offset: 0 })
  const all: MessageRow[] = []
  for (let offset = 0; ; offset += 200) {
    const page = offset === 0 ? rows : listMailbox(alias, mailbox, { limit: 200, offset })
    all.push(...page)
    if (page.length < 200) break
  }

  const known = new Map<number, number>()
  for (const r of readUids.all(alias, mailbox) as { message_id: number; uid: number }[]) {
    known.set(r.message_id, r.uid)
  }

  const present = new Set(all.map((m) => m.id))
  for (const messageId of known.keys()) {
    if (!present.has(messageId)) { dropUid.run(alias, mailbox, messageId); known.delete(messageId) }
  }

  // Oldest first, so UIDs ascend with arrival.
  const ordered = [...all].sort((a, b) => a.internal_date - b.internal_date || a.id - b.id)
  let uidnext = state.uidnext
  const messages: UidMessage[] = []
  for (const row of ordered) {
    let uid = known.get(row.id)
    if (uid === undefined) {
      uid = uidnext++
      assignUid.run(alias, mailbox, row.id, uid)
    }
    messages.push({ uid, row })
  }
  if (uidnext !== state.uidnext) bumpNext.run(uidnext, alias, mailbox)

  messages.sort((a, b) => a.uid - b.uid)
  return { uidvalidity: state.uidvalidity, uidnext, messages }
})
