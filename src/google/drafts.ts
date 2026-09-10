import { getDraftForAlias, getMessageForAlias, allKnownAliases, db } from '../db/index.ts'
import { orgDomain, sharedAccountEmail } from '../core/settings.ts'
import { gmail } from './client.ts'
import { buildMime, toBase64Url, type OutgoingAttachment } from './mime.ts'
import { parseMessage, htmlToText } from './parse.ts'
import { sanitizeHtml } from './sanitize.ts'
import { storeMessage, ownershipContext } from './sync.ts'
import type { Sender } from './actions.ts'

export interface DraftContent {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  /** Gmail id of the message being replied to, so the draft joins its thread. */
  replyToMessageId?: string
  attachments?: OutgoingAttachment[]
}

/** Fetch the stored message behind a draft so the mailbox reflects it at once. */
async function mirror(messageId: string, draftId: string, alias: string): Promise<void> {
  const api = gmail()
  const res = await api.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  storeMessage(parseMessage(res.data), ownershipContext(), alias)

  // An edit keeps the draft id but mints a fresh message id, so the previous
  // revision still holds this draft id and the UNIQUE index would reject the
  // update. Gone from Gmail too, so it is dropped rather than detached.
  db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE gmail_draft_id = ? AND gmail_id <> ?`)
      .run(draftId, messageId)
    db.prepare(`UPDATE messages SET gmail_draft_id = ? WHERE gmail_id = ?`)
      .run(draftId, messageId)
  })()
}

function threadContext(alias: string, replyToMessageId: string | undefined) {
  if (!replyToMessageId) return {}
  // Ownership check: a guessed id must not attach a draft to another's thread.
  const original = getMessageForAlias(alias, replyToMessageId)
  if (!original) throw Object.assign(new Error('Message not found'), { status: 404, key: 'mailbox.messageNotFound' as const })
  return {
    inReplyTo: original.rfc822_id,
    references: original.rfc822_id,
    threadId: original.gmail_thread_id,
  }
}

/** Create or update a draft. `From` comes from the session, as for a send.
 */
export async function saveDraft(
  sender: Sender,
  content: DraftContent,
  draftId?: string,
): Promise<{ draftId: string; messageId: string }> {
  const api = gmail()
  const thread = threadContext(sender.alias, content.replyToMessageId)

  const bodyHtml = content.bodyHtml ? sanitizeHtml(content.bodyHtml) : undefined
  const bodyText = content.bodyText || (bodyHtml ? htmlToText(bodyHtml) : '')

  const raw = toBase64Url(buildMime({
    fromEmail: sender.alias,
    fromName: sender.displayName,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    bodyText,
    bodyHtml,
    inReplyTo: thread.inReplyTo ?? null,
    references: thread.references ?? null,
    attachments: content.attachments,
  }))

  const message = { raw, ...(thread.threadId ? { threadId: thread.threadId } : {}) }

  if (draftId) {
    // Verified before the call so one member cannot overwrite another's draft.
    if (!getDraftForAlias(sender.alias, draftId)) {
      throw Object.assign(new Error('Draft not found'), { status: 404, key: 'mailbox.draftNotFound' as const })
    }
    const res = await api.users.drafts.update({ userId: 'me', id: draftId, requestBody: { message } })
    const messageId = res.data.message?.id
    if (messageId) await mirror(messageId, draftId, sender.alias)
    return { draftId, messageId: messageId ?? '' }
  }

  const res = await api.users.drafts.create({ userId: 'me', requestBody: { message } })
  const created = res.data.id
  const messageId = res.data.message?.id
  if (!created) throw new Error('Gmail did not return a draft id')
  if (messageId) await mirror(messageId, created, sender.alias)
  return { draftId: created, messageId: messageId ?? '' }
}

/** Send a stored draft. Gmail consumes it, so no draft is left behind. */
export async function sendDraft(alias: string, draftId: string) {
  const row = getDraftForAlias(alias, draftId)
  if (!row) throw Object.assign(new Error('Draft not found'), { status: 404, key: 'mailbox.draftNotFound' as const })

  const api = gmail()
  const res = await api.users.drafts.send({ userId: 'me', requestBody: { id: draftId } })

  // Drop the stale draft mapping and re-read, so Sent is correct at once.
  db.prepare(`DELETE FROM messages WHERE gmail_draft_id = ?`).run(draftId)
  if (res.data.id) {
    const sent = await api.users.messages.get({ userId: 'me', id: res.data.id, format: 'full' })
    storeMessage(parseMessage(sent.data), ownershipContext(), alias)
  }
  return { gmailId: res.data.id, threadId: res.data.threadId }
}

export async function discardDraft(alias: string, draftId: string): Promise<void> {
  if (!getDraftForAlias(alias, draftId)) {
    throw Object.assign(new Error('Draft not found'), { status: 404, key: 'mailbox.draftNotFound' as const })
  }
  await gmail().users.drafts.delete({ userId: 'me', id: draftId })
  db.prepare(`DELETE FROM messages WHERE gmail_draft_id = ?`).run(draftId)
}

/**
 * Attach draft ids to mirrored messages. `messages.list` reports the DRAFT
 * label but not the draft id, so drafts written elsewhere would not be
 * editable. Part of each sync.
 */
export async function reconcileDraftIds(): Promise<number> {
  const api = gmail()
  const res = await api.users.drafts.list({ userId: 'me', maxResults: 500 })
  const update = db.prepare(`UPDATE messages SET gmail_draft_id = ? WHERE gmail_id = ?`)

  let linked = 0
  db.transaction(() => {
    for (const draft of res.data.drafts ?? []) {
      if (!draft.id || !draft.message?.id) continue
      const info = update.run(draft.id, draft.message.id)
      if (info.changes > 0) linked++
    }
  })()
  return linked
}
