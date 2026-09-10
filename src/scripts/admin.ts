/**
 * Promote an existing account to admin.
 *
 *   npm run admin -- <username>
 *
 * Activates directly, skipping the Workspace provisioning that approval
 * performs, so it does not depend on a Google API call.
 */
import { migrate, db } from '../db/index.ts'

migrate()

const username = process.argv[2]?.trim().toLowerCase()
if (!username) {
  console.error('Usage: npm run admin -- <username>')
  process.exit(1)
}

const user = db.prepare(`SELECT id, alias_email, status FROM users WHERE username = ?`)
  .get(username) as { id: number; alias_email: string; status: string } | undefined

if (!user) {
  console.error(`No user "${username}". Sign up through the web UI first.`)
  process.exit(1)
}

db.prepare(`
  UPDATE users SET is_admin = 1, status = 'active', approved_at = COALESCE(approved_at, datetime('now'))
  WHERE id = ?
`).run(user.id)

console.log(`${username} (${user.alias_email}) is now an active admin.`)
console.log('Note: the Workspace group and send-as entry were NOT created.')
console.log('If this address needs to send mail, run: npm run provision -- ' + user.alias_email)
