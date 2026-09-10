import { db, messageStateFor, categoryIdsFor, type MessageRow } from '../db/index.ts'

export interface ClientMessage {
  id: string
  threadId: string
  /** Present only for drafts; addresses the draft for update, send or discard. */
  draftId: string | null
  from: string
  fromName: string | null
  to: string[]
  cc: string[]
  subject: string
  snippet: string
  date: number
  labels: string[]
  hasAttachments: boolean
  unread: boolean
  starred: boolean
  archived: boolean
  /** Ids of this member's categories on the message. */
  categories: number[]
  bodyText?: string | null
  bodyHtml?: string | null
  attachments?: unknown[]
}

const attachmentsFor = db.prepare(`
  SELECT gmail_att_id AS id, filename, mime_type AS mimeType, size_bytes AS size
  FROM attachments WHERE message_id = ?
`)

/**
 * Stored row to client shape. Bodies and attachments are opt-in.
 *
 * `alias` is required for read, starred and archived: those belong to the
 * member, not the message, and reading them off the shared labels is what made
 * one member's actions visible to another.
 */
export function toClientMessage(row: MessageRow, alias: string, includeBody = false): ClientMessage {
  const labels = JSON.parse(row.labels) as string[]
  const state = messageStateFor(row.id, alias)
  const base: ClientMessage = {
    id: row.gmail_id,
    threadId: row.gmail_thread_id,
    draftId: row.gmail_draft_id,
    from: row.from_addr,
    fromName: row.from_name,
    to: JSON.parse(row.to_addrs) as string[],
    cc: JSON.parse(row.cc_addrs) as string[],
    subject: row.subject,
    snippet: row.snippet,
    date: row.internal_date,
    labels,
    hasAttachments: row.has_attachments === 1,
    unread: !state.read,
    starred: state.starred,
    archived: state.archived,
    categories: categoryIdsFor(row.id, alias),
  }
  if (!includeBody) return base
  return {
    ...base,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments: attachmentsFor.all(row.id),
  }
}
