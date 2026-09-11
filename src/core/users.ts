import { db, seedMessageState } from '../db/index.ts'
import { hashPassword, validateLocalPart } from './auth.ts'
import { provisionMember, deprovisionMember, listSendAsAliases } from '../google/provisioning.ts'
import { reresolveUnassigned } from '../google/sync.ts'
import { getSetting, isGoogleConnected, orgDomain, orgDomains } from './settings.ts'
import { UserError } from './errors.ts'
import { DEFAULT_LOCALE, t, type MessageKey } from './i18n.ts'

export { UserError }

export interface PendingUser {
  id: number
  username: string
  display_name: string
  alias_local: string | null
  alias_domain: string | null
  alias_email: string | null
  status: string
  is_admin: number
  provisioned: number
  provision_error: string | null
  created_at: string
}

/** Register a signup request. The address is composed at approval. */
export type LocalPartProblem = MessageKey | null

/**
 * Why a requested address cannot be used, or null if it can. Checked whole:
 * with more than one domain, `hong@a` and `hong@b` are different people.
 */
export function checkAddress(localPart: string, domain?: string): LocalPartProblem {
  const formatError = validateLocalPart(localPart)
  if (formatError) return formatError

  const value = localPart.trim().toLowerCase()
  const domains = orgDomains()

  // Before a domain is configured there is nothing to compose an address from,
  // so the local part alone is what can be claimed.
  if (domains.length === 0) {
    const shared = (getSetting('shared_account_email') ?? '').trim().toLowerCase()
    if (shared && shared.split('@')[0] === value) return 'signup.sharedAccount'
    const clash = db.prepare(`
      SELECT 1 FROM users WHERE lower(username) = ? OR lower(alias_local) = ?
    `).get(value, value)
    return clash ? 'signup.taken' : null
  }

  const where = (domain ?? domains[0]!).trim().toLowerCase()
  if (!domains.includes(where)) return 'signup.unknownDomain'
  const address = `${value}@${where}`

  // The shared mailbox is never an owner, so this address would receive nothing.
  const shared = (getSetting('shared_account_email') ?? '').trim().toLowerCase()
  if (shared === address) return 'signup.sharedAccount'

  // Three columns claim an address: the sign-in name, the pair a pending
  // member requested, and the composed address.
  const clash = db.prepare(`
    SELECT 1 FROM users
    WHERE lower(username) = ?
       OR lower(alias_email) = ?
       OR (lower(alias_local) = ? AND lower(COALESCE(alias_domain, ?)) = ?)
  `).get(address, address, value, domains[0]!, where)
  if (clash) return 'signup.taken'

  return null
}

/** Register a signup request. The local part is also the sign-in name. */
export async function signup(input: {
  displayName: string
  localPart: string
  domain?: string
  password: string
}): Promise<{ localPart: string; domain: string | null }> {
  if (input.password.length < 10) {
    throw new UserError('signup.passwordLength')
  }
  if (!input.displayName.trim()) {
    throw new UserError('signup.displayNameRequired')
  }

  const domains = orgDomains()
  const domain = domains.length > 0
    ? (input.domain ?? domains[0]!).trim().toLowerCase()
    : null
  const problem = checkAddress(input.localPart, domain ?? undefined)
  if (problem) throw new UserError(problem)

  const localPart = input.localPart.trim().toLowerCase()
  const passwordHash = await hashPassword(input.password)
  // The sign-in name is the whole address: a local part alone stops being
  // unique the moment a second domain is configured.
  db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_domain,
                       alias_email, password_hash, status)
    VALUES (?, ?, ?, ?, NULL, ?, 'pending')
  `).run(
    domain ? `${localPart}@${domain}` : localPart,
    input.displayName.trim(), localPart, domain, passwordHash,
  )

  return { localPart, domain }
}

/**
 * Approve a pending member: compose the address, provision, activate.
 *
 * Provisioning precedes activation, so a member never reaches an address that
 * does not yet deliver.
 */
export async function approve(
  userId: number,
): Promise<{ alias: string; sendAsError?: string }> {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as PendingUser | undefined
  if (!user) throw new UserError('member.notFound')
  if (user.status === 'active') throw new UserError('member.alreadyApproved')
  if (!user.alias_local) throw new UserError('member.noRequestedAddress')

  if (!getSetting('org_domain')) {
    throw new UserError('setup.noDomain')
  }
  if (!isGoogleConnected()) {
    throw new UserError('setup.notConnected')
  }

  const alias = `${user.alias_local}@${user.alias_domain ?? orgDomain()}`
  const taken = db.prepare(`SELECT 1 FROM users WHERE alias_email = ? AND id != ?`)
    .get(alias, userId)
  if (taken) throw new UserError('member.aliasTaken', { alias })

  let sendAsError: string | undefined
  try {
    const result = await provisionMember(alias, user.display_name)
    sendAsError = result.sendAsError
    // 0 while the send-as entry is missing: receiving works, sending is refused.
    db.prepare(`UPDATE users SET provisioned = ?, provision_error = ? WHERE id = ?`)
      .run(sendAsError ? 0 : 1, sendAsError ?? null, userId)
  } catch (err) {
    db.prepare(`UPDATE users SET provisioned = 0, provision_error = ? WHERE id = ?`)
      .run(String((err as Error).message ?? err), userId)
    throw new UserError('member.provisionFailed', { reason: String((err as Error).message) })
  }

  db.prepare(`
    UPDATE users SET status = 'active', alias_email = ?, approved_at = datetime('now')
    WHERE id = ?
  `).run(alias, userId)

  // Not worth failing approval over; created on demand otherwise.
  try {
    const { ensureHomeFolder } = await import('../google/drive.ts')
    await ensureHomeFolder(userId, alias)
  } catch (err) {
    console.warn(`[approve] Drive folder for ${alias} not created:`, (err as Error).message)
  }

  // Claim mail that arrived for this address before approval.
  reresolveUnassigned()

  return { alias, sendAsError }
}

export async function deactivate(userId: number): Promise<void> {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as PendingUser | undefined
  if (!user) throw new UserError('member.notFound')

  // Deactivating the last operator would lock the deployment out of its own
  // administration, with no path back short of editing the database.
  if (user.is_admin) throw new UserError('member.adminProtected')

  if (user.alias_email) await deprovisionMember(user.alias_email)
  db.prepare(
    `UPDATE users SET status = 'deactivated', deactivated_at = datetime('now') WHERE id = ?`,
  ).run(userId)
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
}

export function reject(userId: number): void {
  const info = db.prepare(`DELETE FROM users WHERE id = ? AND status = 'pending'`).run(userId)
  if (info.changes === 0) throw new UserError('member.noPending')
}

/**
 * Bring `provisioned` in line with the send-as entries that exist.
 *
 * Send-as entries are added by hand outside LabMail, so this runs on every
 * sync tick. Grants and revokes both: a listing that succeeds is authoritative,
 * and one that fails throws without touching anything.
 */
export async function reconcileSendAs(): Promise<void> {
  const members = db.prepare(`
    SELECT id, alias_email, provisioned FROM users
    WHERE status = 'active' AND alias_email IS NOT NULL
  `).all() as { id: number; alias_email: string; provisioned: number }[]
  if (members.length === 0) return

  const registered = await listSendAsAliases()
  const grant = db.prepare(
    `UPDATE users SET provisioned = 1, provision_error = NULL WHERE id = ?`,
  )
  const revoke = db.prepare(
    `UPDATE users SET provisioned = 0, provision_error = ? WHERE id = ?`,
  )
  for (const row of members) {
    const has = registered.has(row.alias_email.trim().toLowerCase())
    if (has && row.provisioned !== 1) grant.run(row.id)
    else if (!has && row.provisioned !== 0) {
      revoke.run('The send-as entry for this address is no longer present.', row.id)
    }
  }
}

/** Whether this member's address can appear as From. */
export function canSend(userId: number): boolean {
  const row = db.prepare(
    `SELECT provisioned FROM users WHERE id = ? AND status = 'active' AND alias_email IS NOT NULL`,
  ).get(userId) as { provisioned: number } | undefined
  return row?.provisioned === 1
}

export function listUsers(): PendingUser[] {
  return db.prepare(`
    SELECT id, username, display_name, alias_local, alias_domain, alias_email,
           status, is_admin, provisioned, provision_error, created_at
    FROM users ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
      created_at DESC
  `).all() as PendingUser[]
}

/** Manual assignment of an unattributed message. */
export function assignMessage(gmailId: string, alias: string): void {
  const message = db.prepare(`SELECT id FROM messages WHERE gmail_id = ?`).get(gmailId) as
    | { id: number }
    | undefined
  if (!message) throw new UserError('mailbox.messageNotFound')

  const known = db.prepare(`SELECT 1 FROM users WHERE alias_email = ?`).get(alias)
  if (!known) throw new UserError('member.notFound')

  const labels = JSON.parse(
    (db.prepare(`SELECT labels FROM messages WHERE id = ?`).get(message.id) as { labels: string })
      .labels,
  ) as string[]

  db.transaction(() => {
    db.prepare(`
      INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'manual')
      ON CONFLICT (message_id, alias) DO NOTHING
    `).run(message.id, alias)
    // Seeded as the sync path does; without it the labels are ignored and the
    // query defaults decide read and archived state.
    seedMessageState(message.id, alias, labels)
  })()
}
