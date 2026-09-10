import { randomBytes } from 'node:crypto'
import { db, allKnownAliases } from '../db/index.ts'
import { orgDomain, sharedAccountEmail, undoSendSeconds } from '../core/settings.ts'
import { gmail } from './client.ts'
import { parseMessage } from './parse.ts'
import { storeMessage, ownershipContext } from './sync.ts'

/**
 * Sends held briefly so they can be recalled. Held server-side, so closing the
 * tab still sends — which is what pressing Send meant.
 */
const timers = new Map<string, NodeJS.Timeout>()

export interface HeldSend {
  id: string
  alias: string
  raw: string
  thread_id: string | null
  draft_id: string | null
  send_at: string
}

/** Hand the message to Gmail and drop the hold. */
export async function flush(id: string): Promise<void> {
  timers.delete(id)
  const row = db.prepare(`SELECT * FROM pending_sends WHERE id = ?`).get(id) as HeldSend | undefined
  if (!row) return                                   // cancelled while waiting

  // Removed before the call: a retry loop would mail the same message twice.
  db.prepare(`DELETE FROM pending_sends WHERE id = ?`).run(id)

  const api = gmail()
  try {
    const sent = await api.users.messages.send({
      userId: 'me',
      requestBody: { raw: row.raw, ...(row.thread_id ? { threadId: row.thread_id } : {}) },
    })
    if (row.draft_id) {
      await api.users.drafts.delete({ userId: 'me', id: row.draft_id }).catch(() => {})
      db.prepare(`DELETE FROM messages WHERE gmail_draft_id = ?`).run(row.draft_id)
    }
    if (sent.data.id) {
      const stored = await api.users.messages.get({ userId: 'me', id: sent.data.id, format: 'full' })
      storeMessage(parseMessage(stored.data), ownershipContext(), row.alias)
    }
  } catch (err) {
    console.error(`[outbox] send ${id} failed:`, (err as Error).message)
  }
}

function arm(id: string, delayMs: number): void {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => { void flush(id) }, Math.max(delayMs, 0))
  // Unreferenced: the row is persisted, and resumeHeldSends re-arms it.
  timer.unref()
  timers.set(id, timer)
}

/** Drop every armed timer without touching the queue. For shutdown and tests. */
export function stopAllTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

/** Queue a message and return the handle the caller can cancel with. */
export function hold(
  alias: string,
  raw: string,
  options: { threadId?: string; draftId?: string } = {},
): { pendingId: string; undoSeconds: number } {
  const seconds = undoSendSeconds()
  const id = randomBytes(12).toString('base64url')
  const sendAt = new Date(Date.now() + seconds * 1000).toISOString()

  db.prepare(`
    INSERT INTO pending_sends (id, alias, raw, thread_id, draft_id, send_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, alias, raw, options.threadId ?? null, options.draftId ?? null, sendAt)

  arm(id, seconds * 1000)
  return { pendingId: id, undoSeconds: seconds }
}

/** Recall a held message. Scoped to the alias; false once the window closed.
 */
export function cancel(alias: string, id: string): boolean {
  const info = db.prepare(`DELETE FROM pending_sends WHERE id = ? AND alias = ?`).run(id, alias)
  if (info.changes === 0) return false
  const timer = timers.get(id)
  if (timer) { clearTimeout(timer); timers.delete(id) }
  return true
}

/** Re-arm holds that outlived a restart. Anything already due goes out at once.
 */
export function resumeHeldSends(): number {
  const rows = db.prepare(`SELECT id, send_at FROM pending_sends`).all() as
    { id: string; send_at: string }[]
  for (const row of rows) arm(row.id, new Date(row.send_at).getTime() - Date.now())
  return rows.length
}
