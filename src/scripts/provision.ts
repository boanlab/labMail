/**
 * Create or repair the Workspace side of an alias.
 *
 *   npm run provision -- hong@example.com ["Hong Gildong"]
 *
 * Approval does this automatically; use for retries and for the operator account.
 */
import { migrate, db } from '../db/index.ts'
import { provisionMember } from '../google/provisioning.ts'

migrate()

const alias = process.argv[2]?.trim().toLowerCase()
if (!alias) {
  console.error('Usage: npm run provision -- <alias@domain> ["Display Name"]')
  process.exit(1)
}

const user = db.prepare(`SELECT display_name FROM users WHERE alias_email = ?`).get(alias) as
  | { display_name: string }
  | undefined
const displayName = process.argv[3] ?? user?.display_name ?? alias.split('@')[0]!

const result = await provisionMember(alias, displayName)

// Left at 0 while the send-as entry is missing, or this would open sending
// from an address Gmail would rewrite to the shared account.
db.prepare(`UPDATE users SET provisioned = ?, provision_error = ? WHERE alias_email = ?`)
  .run(result.sendAsError ? 0 : 1, result.sendAsError ?? null, alias)

console.log(`Provisioned ${alias} (${displayName})`)
if (result.sendAsError) {
  console.log(`Cannot send as ${alias} yet: ${result.sendAsError}`)
  console.log('Add it under the shared account\'s mail settings, then run this again.')
}
process.exit(0)
