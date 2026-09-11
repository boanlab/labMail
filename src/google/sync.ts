import type { gmail_v1 } from 'googleapis'
import { orgDomains, sharedAccountEmail } from '../core/settings.ts'
import { db, allKnownAliases, seedMessageState, type MessageRow, adminAliases } from '../db/index.ts'
import { emitNewMail } from '../core/events.ts'
import { applyRules } from '../core/rules.ts'

/** The row as stored, which is the shape the rules engine matches against. */
const selectMessageStmt = db.prepare(`SELECT * FROM messages WHERE id = ?`)
import { gmail } from './client.ts'
import { parseMessage, type ParsedMessage } from './parse.ts'
import { isSendAsConfirmation, resolveOwners } from './ownership.ts'

/** Transient failures worth retrying. */
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504])

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { code?: number; status?: number })?.code
        ?? (err as { status?: number })?.status
      if (typeof status === 'number' && !RETRYABLE.has(status)) throw err
      // One account's quota serves all members; contention is routine.
      const delay = Math.min(2 ** i * 500, 16_000) + Math.random() * 400
      console.warn(`[sync] ${label} failed (${status ?? 'unknown'}), retry in ${Math.round(delay)}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/** Bounded-concurrency map, sized under the per-account rate limit. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** Everything ownership resolution needs, built in one place for every caller. */
export function ownershipContext() {
  return {
    knownAliases: new Set(allKnownAliases()),
    sharedAccountEmail: sharedAccountEmail(),
    adminAliases: adminAliases(),
    orgDomains: orgDomains(),
  }
}

const upsertMessageStmt = db.prepare(`
  INSERT INTO messages (
    gmail_id, gmail_thread_id, rfc822_id, from_addr, from_name, to_addrs, cc_addrs,
    reply_to, subject, snippet, body_text, body_html, labels, internal_date,
    has_attachments, routing_headers, synced_at
  ) VALUES (
    @gmail_id, @gmail_thread_id, @rfc822_id, @from_addr, @from_name, @to_addrs, @cc_addrs,
    @reply_to, @subject, @snippet, @body_text, @body_html, @labels, @internal_date,
    @has_attachments, @routing_headers, datetime('now')
  )
  ON CONFLICT (gmail_id) DO UPDATE SET
    labels = excluded.labels,
    snippet = excluded.snippet,
    subject = excluded.subject,
    body_text = COALESCE(excluded.body_text, messages.body_text),
    body_html = COALESCE(excluded.body_html, messages.body_html),
    -- Refreshed rather than left alone: the set of headers worth keeping grows
    -- as delivery paths are understood, and a message stored under an older set
    -- would otherwise keep answering ownership questions from stale evidence.
    routing_headers = excluded.routing_headers,
    synced_at = datetime('now')
  RETURNING id
`)

/**
 * Owners, announcing to any that just gained unread mail.
 *
 * Keyed on the owner row, written exactly once per (message, alias): inbox
 * totals cannot serve, because the send path mirrors a message before any tick
 * runs and mail between members is already counted.
 */
const pendingAnnouncements = new Map<string, number>()
let flushScheduled = false

function flushAnnouncements(): void {
  flushScheduled = false
  for (const [alias, count] of pendingAnnouncements) emitNewMail(alias, count)
  pendingAnnouncements.clear()
}

function addOwner(messageId: number, alias: string, source: string, labels: string[]): boolean {
  const inserted = insertOwnerStmt.run(messageId, alias, source).changes > 0
  // Seeded even for an existing owner row, so state arrives without a migration.
  seedMessageState(messageId, alias, labels)
  if (!inserted) return false
  // Only mail this alias received, and only while it is genuinely waiting.
  if (source === 'from') return true
  if (!labels.includes('INBOX') || !labels.includes('UNREAD')) return true
  if (labels.includes('TRASH') || labels.includes('SPAM')) return true

  pendingAnnouncements.set(alias, (pendingAnnouncements.get(alias) ?? 0) + 1)
  if (!flushScheduled) {
    // After the surrounding transaction commits, so a rollback announces nothing.
    flushScheduled = true
    setTimeout(flushAnnouncements, 0)
  }
  return true
}

const insertOwnerStmt = db.prepare(`
  INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, ?)
  ON CONFLICT (message_id, alias) DO NOTHING
`)

const insertAttachmentStmt = db.prepare(`
  INSERT INTO attachments (message_id, gmail_att_id, filename, mime_type, size_bytes)
  VALUES (?, ?, ?, ?, ?)
`)

const clearAttachmentsStmt = db.prepare(`DELETE FROM attachments WHERE message_id = ?`)

/**
 * Persist a message and its ownership. Rows are additive; revoking access is an
 * explicit admin action.
 *
 * `author` names the sender for mail LabMail itself put on the wire. Headers
 * cannot serve: Gmail rewrites From to the shared account for any address with
 * no send-as entry, leaving the message owned by nobody.
 */
export const storeMessage = db.transaction((
  parsed: ParsedMessage,
  ctx: ReturnType<typeof ownershipContext>,
  author?: string,
) => {
  const row = upsertMessageStmt.get({
    gmail_id: parsed.gmailId,
    gmail_thread_id: parsed.gmailThreadId,
    rfc822_id: parsed.rfc822Id,
    from_addr: parsed.fromAddr,
    from_name: parsed.fromName,
    to_addrs: JSON.stringify(parsed.toAddrs),
    cc_addrs: JSON.stringify(parsed.ccAddrs),
    reply_to: parsed.replyTo,
    subject: parsed.subject,
    snippet: parsed.snippet,
    body_text: parsed.bodyText,
    body_html: parsed.bodyHtml,
    labels: JSON.stringify(parsed.labels),
    internal_date: parsed.internalDate,
    has_attachments: parsed.attachments.length > 0 ? 1 : 0,
    routing_headers: JSON.stringify(parsed.routingHeaders),
  }) as { id: number }

  const freshOwners: string[] = []
  const owners = resolveOwners({ headers: parsed.headers, labels: parsed.labels }, ctx)
  if (author && !owners.some((o) => o.alias === author)) {
    owners.push({ alias: author, source: 'from' })
  }
  for (const owner of owners) {
    if (addOwner(row.id, owner.alias, owner.source, parsed.labels)) freshOwners.push(owner.alias)
  }

  // Once, when the message first becomes this member's: re-running on a
  // re-sync would undo an archive they had reversed by hand.
  if (freshOwners.length > 0) {
    const stored = selectMessageStmt.get(row.id) as MessageRow | undefined
    if (stored) for (const alias of freshOwners) applyRules(alias, stored)
  }

  clearAttachmentsStmt.run(row.id)
  for (const att of parsed.attachments) {
    insertAttachmentStmt.run(row.id, att.gmailAttachmentId, att.filename, att.mimeType, att.sizeBytes)
  }
  return row.id
})

const seenBefore = db.prepare(`SELECT 1 FROM messages WHERE gmail_id = ?`)

/**
 * Lift a setup confirmation out of Spam.
 *
 * The code in it is the only way to finish setting up an address, and a
 * confirmation Gmail files as spam is one an operator never finds -- the
 * address then stays unable to send, with nothing to say why. A new domain
 * has no sending history with this mailbox, which is exactly when Gmail is
 * most likely to file one there.
 *
 * Only on first sight, so an operator who files one as spam themselves is not
 * argued with on every tick.
 */
async function rescueConfirmation(parsed: ParsedMessage): Promise<string[]> {
  if (!parsed.labels.includes('SPAM')) return parsed.labels
  if (!isSendAsConfirmation(parsed.headers)) return parsed.labels
  if (seenBefore.get(parsed.gmailId)) return parsed.labels

  try {
    const res = await gmail().users.messages.modify({
      userId: 'me',
      id: parsed.gmailId,
      requestBody: { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] },
    })
    console.log(`[sync] took a setup confirmation out of Spam (${parsed.gmailId})`)
    return res.data.labelIds ?? parsed.labels
  } catch (err) {
    // Worth saying, not worth failing a sync over.
    console.error(`[sync] could not rescue ${parsed.gmailId}:`, (err as Error).message)
    return parsed.labels
  }
}

async function fetchAndStore(ids: string[], ctx: ReturnType<typeof ownershipContext>): Promise<number> {
  const api = gmail()
  let stored = 0
  await mapLimit(ids, 8, async (id) => {
    const res = await withRetry(
      () => api.users.messages.get({ userId: 'me', id, format: 'full' }),
      `messages.get ${id}`,
    )
    const parsed = parseMessage(res.data)
    parsed.labels = await rescueConfirmation(parsed)
    storeMessage(parsed, ctx)
    stored++
  })
  return stored
}

function setHistoryId(historyId: string | null | undefined): void {
  if (!historyId) return
  db.prepare(
    `UPDATE sync_state SET last_history_id = ?, last_synced_at = datetime('now') WHERE id = 1`,
  ).run(String(historyId))
}

export function currentHistoryId(): string | null {
  const row = db.prepare(`SELECT last_history_id FROM sync_state WHERE id = 1`).get() as
    | { last_history_id: string | null }
    | undefined
  return row?.last_history_id ?? null
}

/** Initial backfill, and recovery when the history cursor has expired. */
export async function fullSync(maxMessages = 5_000): Promise<number> {
  const api = gmail()
  const ctx = ownershipContext()
  let pageToken: string | undefined
  let total = 0

  const profile = await withRetry(() => api.users.getProfile({ userId: 'me' }), 'getProfile')

  do {
    const res = await withRetry(
      () => api.users.messages.list({
        userId: 'me',
        maxResults: 500,
        includeSpamTrash: true,
        pageToken,
      }),
      'messages.list',
    )
    const ids = (res.data.messages ?? []).map((m) => m.id!).filter(Boolean)
    total += await fetchAndStore(ids, ctx)
    pageToken = res.data.nextPageToken ?? undefined
    console.log(`[sync] backfilled ${total} messages`)
  } while (pageToken && total < maxMessages)

  // From before the backfill, so mid-run arrivals are not skipped.
  setHistoryId(profile.data.historyId)
  return total
}

/**
 * Deltas since the stored cursor.
 *
 * Falls back to a full sync on an expired cursor (404/410), which Gmail
 * reports after roughly a week offline.
 */
export async function incrementalSync(): Promise<{ changed: number; fellBack: boolean }> {
  const startHistoryId = currentHistoryId()
  if (!startHistoryId) {
    const n = await fullSync()
    return { changed: n, fellBack: true }
  }

  const api = gmail()
  const ctx = ownershipContext()
  const touched = new Set<string>()
  const deleted = new Set<string>()
  let pageToken: string | undefined
  let latestHistoryId = startHistoryId

  try {
    do {
      const res = await withRetry(
        () => api.users.history.list({
          userId: 'me',
          startHistoryId,
          maxResults: 500,
          pageToken,
        }),
        'history.list',
      )

      for (const record of res.data.history ?? []) {
        for (const m of record.messagesAdded ?? []) if (m.message?.id) touched.add(m.message.id)
        for (const m of record.messagesDeleted ?? []) if (m.message?.id) deleted.add(m.message.id)
        // Label changes carry mailbox moves and read state; re-fetch to apply.
        for (const m of record.labelsAdded ?? []) if (m.message?.id) touched.add(m.message.id)
        for (const m of record.labelsRemoved ?? []) if (m.message?.id) touched.add(m.message.id)
      }

      if (res.data.historyId) latestHistoryId = String(res.data.historyId)
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
  } catch (err) {
    const status = (err as { code?: number })?.code
    if (status === 404 || status === 410) {
      console.warn('[sync] history cursor expired, falling back to full sync')
      const n = await fullSync()
      return { changed: n, fellBack: true }
    }
    throw err
  }

  for (const id of deleted) touched.delete(id)

  if (deleted.size > 0) {
    const stmt = db.prepare(`DELETE FROM messages WHERE gmail_id = ?`)
    db.transaction(() => { for (const id of deleted) stmt.run(id) })()
  }

  const stored = await fetchAndStore([...touched], ctx)
  setHistoryId(latestHistoryId)
  return { changed: stored + deleted.size, fellBack: false }
}

/** Link drafts written outside LabMail. Imported lazily to break a cycle. */
export async function linkDrafts(): Promise<number> {
  const { reconcileDraftIds } = await import('./drafts.ts')
  return reconcileDraftIds()
}

/** Re-resolve unattributed messages, e.g. after a member is approved. */
export function reresolveUnassigned(): number {
  const ctx = ownershipContext()
  const rows = db.prepare(`
    SELECT m.id, m.labels, m.routing_headers FROM messages m
    WHERE NOT EXISTS (SELECT 1 FROM message_owners o WHERE o.message_id = m.id)
  `).all() as { id: number; labels: string; routing_headers: string }[]

  let assigned = 0
  db.transaction(() => {
    for (const row of rows) {
      const owners = resolveOwners(
        { headers: JSON.parse(row.routing_headers), labels: JSON.parse(row.labels) },
        ctx,
      )
      const labels = JSON.parse(row.labels) as string[]
      for (const o of owners) addOwner(row.id, o.alias, o.source, labels)
      const stored = selectMessageStmt.get(row.id) as MessageRow | undefined
      if (stored) for (const o of owners) applyRules(o.alias, stored)
      if (owners.length > 0) assigned++
    }
  })()
  return assigned
}
