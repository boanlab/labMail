import { db } from '../db/index.ts'

/**
 * Who reached what, and when.
 *
 * The point of this table is the one question this design cannot otherwise
 * answer: separation between members is enforced by this application's queries,
 * not by Google, so if someone asks whether a colleague read their mail there
 * has to be a record. Everything else it captures — sign-ins, admin decisions,
 * configuration changes — is there because those are the actions that can widen
 * what someone can reach.
 *
 * Writing must never fail an action. A missing audit line is bad; a member
 * unable to open their mail because the log is full is worse.
 */

export const AUDIT_ACTIONS = [
  'signin.ok', 'signin.fail', 'signin.throttled', 'signout',
  'message.read', 'message.send', 'message.action',
  'member.approve', 'member.reject', 'member.deactivate', 'member.assign',
  'settings.save', 'google.connect', 'google.disconnect',
  'account.alias', 'account.password',
  'audit.view',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEntry {
  actor?: string | null
  actorId?: number | null
  action: AuditAction
  target?: string | null
  detail?: Record<string, unknown> | null
  ip?: string | null
}

let insert: import('better-sqlite3').Statement | null = null

export function audit(entry: AuditEntry): void {
  try {
    insert ??= db.prepare(`
      INSERT INTO audit_log (actor, actor_id, action, target, detail, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    insert.run(
      entry.actor ?? null,
      entry.actorId ?? null,
      entry.action,
      entry.target ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.ip ?? null,
    )
  } catch (err) {
    // Never propagates: the caller was doing something else.
    console.error('[audit] could not record', entry.action, (err as Error).message)
  }
}

export interface AuditRow {
  id: number
  at: string
  actor: string | null
  action: string
  target: string | null
  detail: string | null
  ip: string | null
}

export interface AuditQuery {
  actor?: string
  action?: string
  since?: string
  limit?: number
  offset?: number
}

/** Newest first, filtered by whitelisted columns only. */
export function listAudit(query: AuditQuery = {}): { rows: AuditRow[]; hasMore: boolean } {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  const offset = Math.max(query.offset ?? 0, 0)

  const where: string[] = []
  const params: (string | number)[] = []
  if (query.actor) { where.push('actor = ?'); params.push(query.actor) }
  if (query.action) { where.push('action = ?'); params.push(query.action) }
  if (query.since) { where.push('at >= ?'); params.push(query.since) }

  const rows = db.prepare(`
    SELECT id, at, actor, action, target, detail, ip FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit + 1, offset) as AuditRow[]

  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

/** Distinct actors and actions, for the filter controls. */
export function auditFacets(): { actors: string[]; actions: string[] } {
  const actors = (db.prepare(
    `SELECT DISTINCT actor FROM audit_log WHERE actor IS NOT NULL ORDER BY actor`,
  ).all() as { actor: string }[]).map((r) => r.actor)
  const actions = (db.prepare(
    `SELECT DISTINCT action FROM audit_log ORDER BY action`,
  ).all() as { action: string }[]).map((r) => r.action)
  return { actors, actions }
}

/**
 * Drop entries past the retention window.
 *
 * A log that grows without bound eventually becomes the reason the disk fills,
 * and an access record nobody has looked at in a year is not evidence anyone is
 * still going to use.
 */
export function pruneAudit(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0
  const info = db.prepare(
    `DELETE FROM audit_log WHERE at < datetime('now', ?)`,
  ).run(`-${Math.floor(days)} days`)
  return info.changes
}

export function auditSize(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n
}
