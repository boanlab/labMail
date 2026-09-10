import { db, getMessageForAlias, setMessageState, allOwnersRead, type StateField } from '../db/index.ts'
import { gmail } from './client.ts'
import { buildMime, toBase64Url, type OutgoingAttachment } from './mime.ts'
import { parseMessage, htmlToText } from './parse.ts'
import { sanitizeHtml } from './sanitize.ts'
import { storeMessage, ownershipContext } from './sync.ts'
import { orgDomain, sharedAccountEmail } from '../core/settings.ts'
import { allKnownAliases } from '../db/index.ts'

export interface ComposeRequest {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  /** Gmail id of the message being replied to. Ownership is verified. */
  replyToMessageId?: string
  attachments?: OutgoingAttachment[]
}

export interface Sender {
  alias: string
  displayName: string
}

export interface SendResult {
  gmailId?: string | null
  threadId?: string | null
  /** Present when the message is held; cancel it with this handle. */
  pendingId?: string
  undoSeconds?: number
}

/** Send as a member. `sender` comes from the session, never from the payload.
 */
export async function sendAs(
  sender: Sender,
  req: ComposeRequest,
  options: { hold?: boolean } = {},
): Promise<SendResult> {
  const api = gmail()

  let inReplyTo: string | null = null
  let references: string | null = null
  let threadId: string | undefined

  if (req.replyToMessageId) {
    // Ownership check: no threading a reply onto another's conversation.
    const original = getMessageForAlias(sender.alias, req.replyToMessageId)
    if (!original) throw Object.assign(new Error('Message not found'), { status: 404, key: 'mailbox.messageNotFound' as const })
    inReplyTo = original.rfc822_id
    references = original.rfc822_id
    threadId = original.gmail_thread_id
  }

  // Sanitized server-side: this markup is mailed to third parties.
  const bodyHtml = req.bodyHtml ? sanitizeHtml(req.bodyHtml) : undefined
  // Recipients reading in plain text get a real alternative, not an empty part.
  const bodyText = req.bodyText || (bodyHtml ? htmlToText(bodyHtml) : '')

  const raw = buildMime({
    fromEmail: sender.alias,
    fromName: sender.displayName,
    to: req.to,
    cc: req.cc,
    bcc: req.bcc,
    subject: req.subject,
    bodyText,
    bodyHtml,
    inReplyTo,
    references,
    attachments: req.attachments,
  })

  const encoded = toBase64Url(raw)

  if (options.hold) {
    // Held rather than sent, so the member can still recall it.
    const { hold } = await import('./outbox.ts')
    return hold(sender.alias, encoded, threadId ? { threadId } : {})
  }

  const res = await api.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded, ...(threadId ? { threadId } : {}) },
  })

  // Fetched so Sent is correct before the next sync tick.
  if (res.data.id) {
    const stored = await api.users.messages.get({ userId: 'me', id: res.data.id, format: 'full' })
    storeMessage(parseMessage(stored.data), ownershipContext())
  }
  return { gmailId: res.data.id, threadId: res.data.threadId }
}

type LabelChange = { add?: string[]; remove?: string[] }

/**
 * Actions that change the shared mailbox, and therefore reach Gmail. Trash and
 * Spam are properties of the mailbox: true for everyone the message belongs to.
 */
const MAILBOX_ACTIONS: Record<string, LabelChange> = {
  trash: { add: ['TRASH'], remove: ['INBOX'] },
  untrash: { add: ['INBOX'], remove: ['TRASH'] },
  spam: { add: ['SPAM'], remove: ['INBOX'] },
  notspam: { add: ['INBOX'], remove: ['SPAM'] },
}

/**
 * Actions that belong to one member. Two members can own the same message, and
 * the shared labels cannot distinguish one member's read or archive from the
 * other's, so these are recorded per member.
 */
const MEMBER_ACTIONS: Record<string, { field: StateField; value: boolean }> = {
  read: { field: 'is_read', value: true },
  unread: { field: 'is_read', value: false },
  star: { field: 'is_starred', value: true },
  unstar: { field: 'is_starred', value: false },
  archive: { field: 'is_archived', value: true },
  unarchive: { field: 'is_archived', value: false },
  // The member stops seeing it. Permanent deletion needs a scope this
  // application does not request.
  remove: { field: 'is_removed', value: true },
}

/**
 * Reflect the members' collective read state onto Gmail's single UNREAD label.
 *
 * Cleared only once every owner has read the message, and restored the moment
 * one of them marks it unread again. Reading is still per member; this only
 * keeps the shared mailbox from showing mail nobody is waiting on.
 *
 * Best effort: the member's own state is already recorded, and a Google
 * failure must not turn their click into an error.
 */
async function syncUnread(messageId: number, gmailId: string): Promise<string[]> {
  const stored = db.prepare(`SELECT labels FROM messages WHERE id = ?`).get(messageId) as
    | { labels: string }
    | undefined
  const labels = JSON.parse(stored?.labels ?? '[]') as string[]
  const shouldBeUnread = !allOwnersRead(messageId)
  if (shouldBeUnread === labels.includes('UNREAD')) return labels

  try {
    const res = await gmail().users.messages.modify({
      userId: 'me',
      id: gmailId,
      requestBody: shouldBeUnread ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] },
    })
    const next = res.data.labelIds ?? []
    db.prepare(`UPDATE messages SET labels = ?, synced_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(next), messageId)
    return next
  } catch (err) {
    console.error(`[actions] UNREAD sync for ${gmailId} failed:`, (err as Error).message)
    return labels
  }
}

/**
 * Apply a mailbox action.
 *
 * Fixed verbs only; client label ids are never forwarded. Ownership is
 * verified before the Gmail call.
 */
export async function applyAction(alias: string, gmailId: string, action: string) {
  const message = getMessageForAlias(alias, gmailId)
  if (!message) throw Object.assign(new Error('Message not found'), { status: 404 })

  const member = MEMBER_ACTIONS[action]
  if (member) {
    setMessageState(message.id, alias, member.field, member.value)
    if (member.field === 'is_read') return await syncUnread(message.id, gmailId)
    return JSON.parse(message.labels) as string[]
  }

  const change = MAILBOX_ACTIONS[action]
  if (!change) throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400, key: 'error.notFound' as const })

  const api = gmail()
  const res = await api.users.messages.modify({
    userId: 'me',
    id: gmailId,
    requestBody: { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] },
  })

  db.prepare(`UPDATE messages SET labels = ?, synced_at = datetime('now') WHERE gmail_id = ?`)
    .run(JSON.stringify(res.data.labelIds ?? []), gmailId)

  return res.data.labelIds ?? []
}

/** Attachment bytes, gated on ownership of the parent message. */
export async function fetchAttachment(alias: string, gmailId: string, attachmentId: string) {
  const message = getMessageForAlias(alias, gmailId)
  if (!message) throw Object.assign(new Error('Message not found'), { status: 404 })

  const meta = db.prepare(
    `SELECT * FROM attachments WHERE message_id = ? AND gmail_att_id = ?`,
  ).get(message.id, attachmentId) as
    | { filename: string; mime_type: string }
    | undefined
  if (!meta) throw Object.assign(new Error('Attachment not found'), { status: 404, key: 'mailbox.messageNotFound' as const })

  const res = await gmail().users.messages.attachments.get({
    userId: 'me',
    messageId: gmailId,
    id: attachmentId,
  })
  return {
    filename: meta.filename,
    mimeType: meta.mime_type,
    content: Buffer.from(res.data.data ?? '', 'base64url'),
  }
}
