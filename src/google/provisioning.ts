import { sharedAccountEmail } from '../core/settings.ts'
import { gmail, admin } from './client.ts'

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number; errors?: { reason?: string }[] }
  return e?.code === 409 || e?.errors?.some((x) => x.reason === 'duplicate') === true
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number })?.code === 404
}

const MEMBER_RETRIES = [1_000, 2_000, 4_000, 8_000]

/**
 * Member address as a Group, with the shared mailbox as its only member.
 *
 * Addressed by the group's id rather than its address: a freshly created group
 * is not resolvable by address for a few seconds, and adding the member is
 * retried through that window.
 */
export async function createGroupAlias(aliasEmail: string, displayName: string): Promise<void> {
  const api = admin()

  let groupId: string | undefined
  try {
    const created = await api.groups.insert({
      requestBody: {
        email: aliasEmail,
        name: `${displayName} (labMail)`,
        description: 'labMail per-member address. Delivers to the shared mailbox.',
      },
    })
    groupId = created.data.id ?? undefined
  } catch (err) {
    if (!isAlreadyExists(err)) throw err
    const existing = await api.groups.get({ groupKey: aliasEmail })
    groupId = existing.data.id ?? undefined
  }

  const key = groupId ?? aliasEmail
  for (let attempt = 0; ; attempt++) {
    try {
      await api.members.insert({
        groupKey: key,
        requestBody: { email: sharedAccountEmail(), role: 'MEMBER', delivery_settings: 'ALL_MAIL' },
      })
      return
    } catch (err) {
      if (isAlreadyExists(err)) return
      if (!isNotFound(err) || attempt >= MEMBER_RETRIES.length) throw err
      await new Promise((r) => setTimeout(r, MEMBER_RETRIES[attempt]))
    }
  }
}

export interface SendAsResult {
  verified: boolean
  /** Why the address cannot send yet, when it cannot. */
  sendAsError?: string
}

/**
 * Send-as addresses the shared account can currently send from.
 *
 * Read-only, and unlike creating one it needs no domain-wide delegation — so
 * an alias added by hand in Gmail settings is visible to labMail even though
 * labMail could not have created it.
 */
export async function listSendAsAliases(): Promise<Set<string>> {
  const res = await gmail().users.settings.sendAs.list({ userId: 'me' })
  const usable = new Set<string>()
  for (const entry of res.data.sendAs ?? []) {
    if (!entry.sendAsEmail) continue
    // Primary needs no verification; an alias counts only once accepted.
    if (entry.isPrimary || entry.verificationStatus === 'accepted' || entry.verificationStatus == null) {
      usable.add(entry.sendAsEmail.trim().toLowerCase())
    }
  }
  return usable
}

export async function provisionMember(aliasEmail: string, displayName: string): Promise<SendAsResult> {
  // Making the address deliverable is what an approval is for, so a failure
  // here is still fatal to it.
  await createGroupAlias(aliasEmail, displayName)

  // Sending is a separate question, and not one labMail can settle: the
  // send-as entry has to be added by hand. Report it as missing unless it is
  // already there, and let the sync tick notice when it appears.
  const registered = await listSendAsAliases()
  if (registered.has(aliasEmail.trim().toLowerCase())) return { verified: true }

  return {
    verified: false,
    sendAsError: 'The send-as entry for this address has not been added yet.',
  }
}

/**
 * Revoke sending for a departed member.
 *
 * The alias remains so their mail keeps arriving and staying attributed; only
 * the ability to send as them is withdrawn. Gmail recreates the send-as entry
 * from the alias, so this is reversed by nothing more than removing the alias.
 */
export async function deprovisionMember(aliasEmail: string): Promise<void> {
  try {
    await gmail().users.settings.sendAs.delete({ userId: 'me', sendAsEmail: aliasEmail })
  } catch (err) {
    if ((err as { code?: number })?.code !== 404) throw err
  }
}
