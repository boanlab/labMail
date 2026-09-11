import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOwners, type Headers } from '../src/google/ownership.ts'
import { canonicalize, formatAddress, parseAddressList } from '../src/google/addresses.ts'

const ctx = {
  knownAliases: new Set(['hong@example.com', 'kim@example.com', 'old@example.com']),
  sharedAccountEmail: 'shared@example.com',
  orgDomains: ['example.com'],
}

const h = (o: Record<string, string | string[]>): Headers =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v : [v]]))

test('attributes ordinary inbound mail from the To header', () => {
  const owners = resolveOwners(
    { headers: h({ To: 'Hong <hong@example.com>', From: 'ext@other.org' }), labels: ['INBOX'] },
    ctx,
  )
  assert.deepEqual(owners, [{ alias: 'hong@example.com', source: 'to' }])
})

test('recovers a BCC recipient from X-Gm-Original-To', () => {
  // The whole point of the routing header: the address appears nowhere else.
  const owners = resolveOwners(
    {
      headers: h({
        'X-Gm-Original-To': 'kim@example.com',
        To: 'someone-else@other.org',
        From: 'ext@other.org',
      }),
      labels: ['INBOX'],
    },
    ctx,
  )
  assert.deepEqual(owners, [{ alias: 'kim@example.com', source: 'x-gm-original-to' }])
})

test('assigns both members when one message is addressed to two', () => {
  const owners = resolveOwners(
    {
      headers: h({ To: 'hong@example.com, Kim <kim@example.com>', From: 'ext@other.org' }),
      labels: ['INBOX'],
    },
    ctx,
  )
  assert.deepEqual(owners.map((o) => o.alias).sort(), ['hong@example.com', 'kim@example.com'])
})

test('ignores a spoofed From on inbound mail', () => {
  // Without the SENT gate, anyone could inject mail into a member's mailbox
  // just by putting their alias in From.
  const owners = resolveOwners(
    { headers: h({ From: 'hong@example.com', To: 'victim@other.org' }), labels: ['INBOX'] },
    ctx,
  )
  assert.deepEqual(owners, [])
})

test('attributes outbound mail to the sending alias', () => {
  const owners = resolveOwners(
    { headers: h({ From: 'Hong <hong@example.com>', To: 'ext@other.org' }), labels: ['SENT'] },
    ctx,
  )
  assert.deepEqual(owners, [{ alias: 'hong@example.com', source: 'from' }])
})

test('gives both sender and recipient a copy when members mail each other', () => {
  // Gmail collapses this into one message carrying SENT and INBOX together.
  const owners = resolveOwners(
    {
      headers: h({ From: 'hong@example.com', To: 'kim@example.com' }),
      labels: ['SENT', 'INBOX'],
    },
    ctx,
  )
  assert.deepEqual(owners.map((o) => o.alias).sort(), ['hong@example.com', 'kim@example.com'])
})

test('never assigns the shared mailbox itself as an owner', () => {
  const owners = resolveOwners(
    { headers: h({ To: 'shared@example.com', From: 'ext@other.org' }), labels: ['INBOX'] },
    ctx,
  )
  assert.deepEqual(owners, [])
})

test('ignores lookalike addresses on other domains', () => {
  const owners = resolveOwners(
    { headers: h({ To: 'hong@example.com.evil.net', From: 'ext@other.org' }), labels: ['INBOX'] },
    ctx,
  )
  assert.deepEqual(owners, [])
})

test('leaves unattributable mail unassigned rather than guessing', () => {
  const owners = resolveOwners(
    { headers: h({ To: 'nobody@example.com', From: 'ext@other.org' }), labels: ['INBOX'] },
    ctx,
  )
  assert.deepEqual(owners, [])
})

test('still attributes mail for a graduated member', () => {
  const owners = resolveOwners(
    { headers: h({ To: 'old@example.com', From: 'ext@other.org' }), labels: ['INBOX'] },
    ctx,
  )
  assert.deepEqual(owners, [{ alias: 'old@example.com', source: 'to' }])
})

test('prefers the envelope recipient over weaker headers for the same alias', () => {
  const owners = resolveOwners(
    {
      headers: h({ 'X-Gm-Original-To': 'hong@example.com', Cc: 'hong@example.com' }),
      labels: ['INBOX'],
    },
    ctx,
  )
  assert.deepEqual(owners, [{ alias: 'hong@example.com', source: 'x-gm-original-to' }])
})

test('canonicalize strips plus tags but preserves dots', () => {
  assert.equal(canonicalize('Hong+ArXiv@Example.COM'), 'hong@example.com')
  // Dot-folding is a gmail.com rule; on a custom domain these are two people.
  assert.equal(canonicalize('hong.gd@example.com'), 'hong.gd@example.com')
})

test('parses display names containing commas', () => {
  const parsed = parseAddressList('"Hong, Gildong" <hong@example.com>, kim@example.com')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]!.email, 'hong@example.com')
  assert.equal(parsed[0]!.name, 'Hong, Gildong')
})

test('formatAddress strips newlines so a display name cannot inject headers', () => {
  const out = formatAddress('hong@example.com', 'Hong\r\nBcc: attacker@evil.net')
  assert.ok(!out.includes('\n') && !out.includes('\r'))
})

test('a group redistribution is attributed by X-BeenThere', () => {
  // Every provisioned member address is a Google Group with the shared mailbox
  // as its only member, so their mail arrives as a redistribution: Delivered-To
  // names the shared account and the routing header does not survive the hop.
  const owners = resolveOwners({
    headers: {
      'delivered-to': ['crew@example.com'],
      'x-beenthere': ['hong@example.com; h="ATskLdfInCZZ0bZJ"'],
      to: ['hong@example.com'],
      from: ['outsider@elsewhere.test'],
    },
    labels: ['INBOX'],
  }, ctx)
  assert.deepEqual(owners, [{ alias: 'hong@example.com', source: 'x-beenthere' }])
})

test('a bcc through a group is still attributed', () => {
  // Nothing in To or Cc names the member; the group header is the only witness.
  const owners = resolveOwners({
    headers: {
      'delivered-to': ['crew@example.com'],
      'x-beenthere': ['hong@example.com; h="ATskLdf"'],
      to: ['someone@elsewhere.test'],
      from: ['outsider@elsewhere.test'],
    },
    labels: ['INBOX'],
  }, ctx)
  assert.deepEqual(owners.map((o) => o.alias), ['hong@example.com'])
})

test('the envelope recipient outranks the group header when both are present', () => {
  const owners = resolveOwners({
    headers: {
      'x-gm-original-to': ['kim@example.com'],
      'x-beenthere': ['hong@example.com; h="x"'],
    },
    labels: ['INBOX'],
  }, ctx)
  assert.equal(owners[0]!.source, 'x-gm-original-to')
  assert.equal(owners[0]!.alias, 'kim@example.com')
})

test('a group header naming the shared account is not an owner', () => {
  const owners = resolveOwners({
    headers: { 'x-beenthere': ['crew@example.com; h="x"'], from: ['a@b.test'] },
    labels: ['INBOX'],
  }, ctx)
  assert.deepEqual(owners, [])
})

test('a malformed group header is ignored rather than guessed at', () => {
  const owners = resolveOwners({
    headers: { 'x-beenthere': ['; h="no address here"'], to: ['hong@example.com'] },
    labels: ['INBOX'],
  }, ctx)
  assert.deepEqual(owners, [{ alias: 'hong@example.com', source: 'to' }])
})

test('mail to the shared mailbox itself belongs to the operators', () => {
  // Google's notices about the account, a send-as confirmation: addressed to
  // the container rather than to a person, and the operator's business.
  const owners = resolveOwners({
    headers: { 'delivered-to': ['shared@example.com'], to: ['shared@example.com'],
               from: ['no-reply@accounts.google.com'] },
    labels: ['INBOX'],
  }, { ...ctx, adminAliases: ['boan@example.com'] })
  assert.deepEqual(owners, [{ alias: 'boan@example.com', source: 'shared-account' }])
})

test('a member on the same message outranks the operators', () => {
  const owners = resolveOwners({
    headers: { to: ['shared@example.com', 'hong@example.com'] },
    labels: ['INBOX'],
  }, { ...ctx, adminAliases: ['boan@example.com'] })
  assert.deepEqual(owners.map((o) => o.alias), ['hong@example.com'])
})

test('an operator whose address is the shared account is still not an owner', () => {
  // The collision that leaves an account receiving nothing: it must not be
  // reintroduced through this fallback.
  const owners = resolveOwners({
    headers: { to: ['shared@example.com'] },
    labels: ['INBOX'],
  }, { ...ctx, adminAliases: ['shared@example.com'] })
  assert.deepEqual(owners, [])
})

test('with no operators the mail stays unattributed', () => {
  const owners = resolveOwners({
    headers: { to: ['shared@example.com'] }, labels: ['INBOX'],
  }, { ...ctx, adminAliases: [] })
  assert.deepEqual(owners, [])
})

test('a send-as confirmation goes to the operators, not to the member', () => {
  // Addressed to the member whose address is being set up, but it carries a
  // code only an operator can use.
  const owners = resolveOwners({
    headers: {
      from: ['Gmail Team <forwarding-noreply@google.com>'],
      to: ['hong@example.com'],
      subject: ['Gmail Confirmation - Send Mail As hong@example.com'],
    },
    labels: ['INBOX'],
  }, { ...ctx, adminAliases: ['boan@example.com'] })
  assert.deepEqual(owners, [{ alias: 'boan@example.com', source: 'confirmation' }])
})

test('with no operator a confirmation falls back to ordinary attribution', () => {
  const owners = resolveOwners({
    headers: {
      from: ['Gmail Team <forwarding-noreply@google.com>'],
      to: ['hong@example.com'],
    },
    labels: ['INBOX'],
  }, { ...ctx, adminAliases: [] })
  assert.deepEqual(owners.map((o) => o.alias), ['hong@example.com'])
})

test('ordinary mail to a member is untouched by the confirmation rule', () => {
  const owners = resolveOwners({
    headers: { from: ['someone@example.org'], to: ['hong@example.com'] },
    labels: ['INBOX'],
  }, { ...ctx, adminAliases: ['boan@example.com'] })
  assert.deepEqual(owners.map((o) => o.alias), ['hong@example.com'])
})

test('a second domain is recognised alongside the first', () => {
  // Secondary domains issue different addresses, not aliases of the first, so
  // both have to be accepted as places a member's mail can arrive.
  const ctx2 = {
    ...ctx,
    orgDomains: ['example.com', 'second.example'],
    knownAliases: new Set([...ctx.knownAliases, 'hong@second.example']),
  }
  const owners = resolveOwners({
    headers: { to: ['hong@second.example'] }, labels: ['INBOX'],
  }, ctx2)
  assert.deepEqual(owners.map((o) => o.alias), ['hong@second.example'])
})

test('a domain the deployment does not issue is still an outside party', () => {
  const owners = resolveOwners({
    headers: { to: ['hong@elsewhere.test'] }, labels: ['INBOX'],
  }, { ...ctx, knownAliases: new Set([...ctx.knownAliases, 'hong@elsewhere.test']) })
  assert.deepEqual(owners, [])
})
