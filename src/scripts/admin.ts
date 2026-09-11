/**
 * Promote an existing account to admin.
 *
 *   npm run admin -- <address-or-name>
 *
 * Activates directly, skipping the Workspace provisioning that approval
 * performs, so it does not depend on a Google API call.
 */
import { migrate, db } from '../db/index.ts'

migrate()

const identifier = process.argv[2]?.trim().toLowerCase()
if (!identifier) {
  console.error('Usage: npm run admin -- <address-or-name>')
  process.exit(1)
}

// Sign-in names are addresses; an operator account predating that keeps a bare
// name, and either is what someone would type here.
const user = db.prepare(`
  SELECT id, username, alias_email, status FROM users
  WHERE lower(username) = ? OR lower(alias_email) = ?
`).get(identifier, identifier) as
  | { id: number; username: string; alias_email: string | null; status: string }
  | undefined

if (!user) {
  console.error(`No account "${identifier}". Sign up through the web UI first.`)
  process.exit(1)
}

db.prepare(`
  UPDATE users SET is_admin = 1, status = 'active', approved_at = COALESCE(approved_at, datetime('now'))
  WHERE id = ?
`).run(user.id)

console.log(`${user.username} (${user.alias_email ?? 'no address yet'}) is now an active admin.`)
console.log('Note: the Workspace group and send-as entry were NOT created.')
if (user.alias_email) {
  console.log('If this address needs to send mail, run: npm run provision -- ' + user.alias_email)
}
