import { db } from '../db/index.ts'
import { getSetting } from '../core/settings.ts'

/**
 * Report whether the Admin console routing rules are actually taking effect.
 *
 *   npm run diagnose:routing
 *
 * Checklist step 6 cannot be read back from Google, so it is inferred from the
 * mail that arrived: whether `X-Gm-Original-To` is present on externally
 * delivered messages, and what the receiving side concluded about DKIM. Both
 * are only knowable from real traffic, which is why this is a report rather
 * than a check the setup screen could run on demand.
 */

const domain = (getSetting('org_domain') ?? '').toLowerCase()
const shared = (getSetting('shared_account_email') ?? '').toLowerCase()

interface Row { subject: string; from_addr: string; labels: string; routing_headers: string }

const rows = db.prepare(`
  SELECT subject, from_addr, labels, routing_headers
  FROM messages
  WHERE NOT EXISTS (SELECT 1 FROM json_each(labels) WHERE value IN ('DRAFT', 'SENT'))
  ORDER BY internal_date DESC
  LIMIT 200
`).all() as Row[]

const external = rows.filter((r) => !r.from_addr.toLowerCase().endsWith(`@${domain}`))

let viaRouting = 0
let viaGroup = 0
let dkimPass = 0
let dkimFail = 0
let dkimUnknown = 0
const missing: string[] = []

for (const row of external) {
  const headers = JSON.parse(row.routing_headers) as Record<string, string[]>
  // Two delivery paths, two witnesses to the envelope recipient. A provisioned
  // member address is a Google Group, and group redistribution carries
  // X-BeenThere rather than the routing rule's header.
  if (headers['x-gm-original-to']?.length) viaRouting++
  else if (headers['x-beenthere']?.length) viaGroup++
  else missing.push(row.subject || '(no subject)')

  const auth = (headers['authentication-results'] ?? []).join(' ').toLowerCase()
  if (!auth) dkimUnknown++
  else if (/dkim=pass/.test(auth)) dkimPass++
  else dkimFail++
}

const pct = (n: number) => (external.length ? Math.round((n / external.length) * 100) : 0)

console.log(`Domain ${domain || '(unset)'}, shared account ${shared || '(unset)'}`)
console.log(`Mirrored messages: ${rows.length}, of which externally sent: ${external.length}`)

if (external.length === 0) {
  console.log('\nNothing received from outside the domain yet, so routing cannot be judged.')
  console.log('Send one message from an outside mailbox to a member address and run this again.')
  process.exit(0)
}

const attributable = viaRouting + viaGroup
console.log(`\n1. Envelope recipient — can a BCC be attributed?`)
console.log(`   yes on ${attributable}/${external.length} (${pct(attributable)}%)`)
console.log(`     X-Gm-Original-To (default routing): ${viaRouting}`)
console.log(`     X-BeenThere (Google Group):         ${viaGroup}`)
if (attributable === external.length) {
  console.log('   OK. Every message names the address the sender actually used.')
} else {
  console.log('   MISSING on some mail. Without the envelope recipient, a BCC to a member')
  console.log('   cannot be attributed and lands in the unassigned queue.')
  console.log('   A provisioned member address is a Google Group, and its mail carries')
  console.log('   X-BeenThere. Addresses that exist only as routing targets — one not yet')
  console.log('   provisioned, or an operator account\'s own — need the routing rule instead:')
  console.log('   Apps > Gmail > Routing > Routing: check "Inbound" and "Internal - receiving",')
  console.log('   check all three account types, and enable "Add X-Gm-Original-To header".')
  for (const subject of missing.slice(0, 5)) console.log(`     · ${subject.slice(0, 60)}`)
}

console.log(`\n2. DKIM — as judged by this mailbox on arrival`)
console.log(`   pass ${dkimPass}, fail ${dkimFail}, not reported ${dkimUnknown}`)
console.log('   Note: this reflects the sending domain\'s DKIM, not yours. Outbound DKIM for')
console.log('   this domain can only be confirmed by what a recipient elsewhere reports.')

const unassigned = (db.prepare(`
  SELECT COUNT(*) AS n FROM messages m
  WHERE NOT EXISTS (SELECT 1 FROM message_owners o WHERE o.message_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value IN ('DRAFT', 'SENT', 'TRASH'))
`).get() as { n: number }).n
console.log(`\n3. Unassigned queue: ${unassigned} message(s)`)
if (unassigned > 0) console.log('   Mail whose recipient could not be resolved is waiting for an admin.')
