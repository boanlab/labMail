import { randomBytes } from 'node:crypto'
import { db } from '../db/index.ts'
import { hashPassword, verifyPassword } from './auth.ts'
import { UserError } from './errors.ts'

export interface AppPassword {
  id: number
  label: string
  createdAt: string
  lastUsedAt: string | null
}

const MAX_PER_MEMBER = 20
const MAX_LABEL = 40

/**
 * Groups of four from an alphabet without look-alikes.
 *
 * Read off one screen and typed into another, often on a phone, so `0`/`O` and
 * `1`/`l` are left out rather than trusted to the reader.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function generate(): string {
  const bytes = randomBytes(16)
  let out = ''
  for (const [i, byte] of bytes.entries()) {
    if (i > 0 && i % 4 === 0) out += '-'
    out += ALPHABET[byte % ALPHABET.length]
  }
  return out
}

export function listAppPasswords(userId: number): AppPassword[] {
  return db.prepare(`
    SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId) as AppPassword[]
}

export function hasAppPassword(userId: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM app_passwords WHERE user_id = ?`).get(userId))
}

/** The secret is returned once and never stored in a form that can show it. */
export async function createAppPassword(
  userId: number, label: string,
): Promise<{ id: number; secret: string }> {
  const name = label.trim().slice(0, MAX_LABEL)
  if (!name) throw new UserError('appPassword.noLabel')
  const count = db.prepare(`SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?`)
    .get(userId) as { n: number }
  if (count.n >= MAX_PER_MEMBER) throw new UserError('appPassword.tooMany')

  const secret = generate()
  const id = db.prepare(`
    INSERT INTO app_passwords (user_id, label, password_hash) VALUES (?, ?, ?)
  `).run(userId, name, await hashPassword(secret)).lastInsertRowid as number
  return { id, secret }
}

export function revokeAppPassword(userId: number, id: number): boolean {
  return db.prepare(`DELETE FROM app_passwords WHERE id = ? AND user_id = ?`)
    .run(id, userId).changes > 0
}

/**
 * Match a secret against this member's app passwords.
 *
 * Every candidate is tried rather than stopping at the first: the hashes carry
 * their own salts, so there is nothing to look up by, and a member holds a
 * handful at most.
 */
export async function verifyAppPassword(userId: number, secret: string): Promise<boolean> {
  const rows = db.prepare(`SELECT id, password_hash FROM app_passwords WHERE user_id = ?`)
    .all(userId) as { id: number; password_hash: string }[]
  for (const row of rows) {
    if (!await verifyPassword(secret, row.password_hash)) continue
    db.prepare(`UPDATE app_passwords SET last_used_at = datetime('now') WHERE id = ?`).run(row.id)
    return true
  }
  return false
}
