import { db } from '../db/index.ts'
import { sanitizeHtml } from '../google/sanitize.ts'
import { hashPassword, verifyPassword } from './auth.ts'
import { UserError } from './users.ts'

/** Longest signature accepted, generous for a few lines with a link. */
const MAX_SIGNATURE_BYTES = 8 * 1024

/**
 * Store a member's signature.
 *
 * Sanitized on the way in rather than at send time: the same markup is rendered
 * back into the composer, so cleaning it once here keeps both paths honest.
 */
export function setSignature(userId: number, html: string): string {
  const trimmed = html.slice(0, MAX_SIGNATURE_BYTES)
  const clean = sanitizeHtml(trimmed).trim()
  db.prepare(`UPDATE users SET signature = ? WHERE id = ?`).run(clean || null, userId)
  return clean
}

/**
 * Update a member's display name.
 *
 * This is the name recipients see in the From header, so it is trimmed and
 * length-capped; CR and LF are stripped by the MIME builder in any case.
 */
export function setDisplayName(userId: number, name: string): string {
  const clean = name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)
  if (!clean) throw Object.assign(new Error('Display name is required'), {
    status: 400, key: 'signup.displayNameRequired' as const,
  })
  db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(clean, userId)
  return clean
}

export function getSignature(userId: number): string | null {
  const row = db.prepare(`SELECT signature FROM users WHERE id = ?`).get(userId) as
    | { signature: string | null }
    | undefined
  return row?.signature ?? null
}

/**
 * Change a member's own password.
 *
 * The current password is required even though the caller already holds a
 * session: a borrowed browser should not be enough to take the account over.
 * Every other session is dropped on success, which is what makes a change
 * after a suspected compromise actually end the intruder's access.
 */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  keepToken: string | undefined,
): Promise<void> {
  const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
    | { password_hash: string }
    | undefined
  if (!row) throw new UserError('member.notFound')

  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw new UserError('password.wrongCurrent')
  }
  if (newPassword.length < 10) {
    throw new UserError('signup.passwordLength')
  }
  if (newPassword === currentPassword) {
    throw new UserError('password.unchanged')
  }

  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
    .run(await hashPassword(newPassword), userId)
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token IS NOT ?`)
    .run(userId, keepToken ?? null)
}
