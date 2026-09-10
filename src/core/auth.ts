import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { db } from '../db/index.ts'
import { orgDomain } from './settings.ts'
import type { MessageKey } from './i18n.ts'

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>

const KEYLEN = 64
const SESSION_DAYS = 14

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), KEYLEN)
  const expected = Buffer.from(keyHex, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

export interface SessionUser {
  id: number
  username: string
  displayName: string
  /** HTML appended to composed messages. */
  signature: string | null
  /** null for the bootstrap admin until a mailbox is assigned. */
  alias: string | null
  isAdmin: boolean
}

export function createSession(userId: number): string {
  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, expires)
  return token
}

/**
 * Session cookie to acting member.
 *
 * The returned alias is the only scope a request may touch. Deactivated
 * accounts resolve to null, so revocation is immediate.
 */
export function loadSession(token: string | undefined): SessionUser | null {
  if (!token) return null
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.alias_email, u.is_admin, u.signature
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
      AND s.expires_at > datetime('now')
      AND u.status = 'active'
  `).get(token) as
    | {
        id: number; username: string; display_name: string
        alias_email: string | null; is_admin: number; signature: string | null
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    alias: row.alias_email,
    isAdmin: row.is_admin === 1,
    signature: row.signature,
  }
}

export function destroySession(token: string | undefined): void {
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token)
}

export function purgeExpiredSessions(): void {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run()
}

/** Local-part rules for an address the organization can hand out. */
export function validateLocalPart(local: string): MessageKey | null {
  const value = local.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/.test(value)) return 'address.format'
  if (value.includes('..')) return 'address.consecutiveDots'
  return null
}

export function aliasFor(localPart: string): string {
  return `${localPart.trim().toLowerCase()}@${orgDomain()}`
}
