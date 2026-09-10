import { db } from '../db/index.ts'
import { verifyPassword } from '../core/auth.ts'
import { hasAppPassword, verifyAppPassword } from '../core/app-passwords.ts'

export interface MailIdentity {
  userId: number
  alias: string
  displayName: string
  /** Whether this address may appear as From. */
  canSend: boolean
}

interface Row {
  id: number
  display_name: string
  alias_email: string | null
  password_hash: string
  provisioned: number
}

/**
 * Authenticate a mail client: the one place SMTP and IMAP check credentials.
 *
 * A member holding an app password can no longer reach mail with their sign-in
 * password. Accepting both would leave it on every device anyway, which is the
 * exposure app passwords remove; members holding none keep using it, so
 * nothing breaks before there is somewhere to move to.
 *
 * A decoy hash keeps timing flat when the account does not exist.
 */
const DECOY = 'scrypt$00$00'

export async function verifyMailCredential(
  username: string, secret: string,
): Promise<MailIdentity | null> {
  const identifier = username.trim().toLowerCase()
  const row = db.prepare(`
    SELECT id, display_name, alias_email, password_hash, provisioned
    FROM users
    WHERE status = 'active' AND alias_email IS NOT NULL
      AND (alias_email = ? OR username = ?)
  `).get(identifier, identifier) as Row | undefined

  const ok = row && hasAppPassword(row.id)
    ? await verifyAppPassword(row.id, secret)
    : await verifyPassword(secret, row?.password_hash ?? DECOY)
  if (!row || !ok) return null

  return {
    userId: row.id,
    alias: row.alias_email!,
    displayName: row.display_name,
    canSend: row.provisioned === 1,
  }
}
