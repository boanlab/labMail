import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'labmail-rules-'))
process.env.ADMIN_PASSWORD = 'test-admin-password'
process.env.DATABASE_PATH = join(dir, 'test.db')

const { db, migrate, listMailbox, seedMessageState, messageStateFor, categoryIdsFor } =
  await import('../src/db/index.ts')
const { createCategory, listCategories } = await import('../src/core/categories.ts')
const { createRule, updateRule, deleteRule, listRules, setRuleEnabled, applyRules,
  applyRulesToExisting } = await import('../src/core/rules.ts')

const HONG = 'hong@example.com'
const KIM = 'kim@example.com'
let categoryId = 0

const insert = (over: Partial<Record<string, unknown>> = {}) => {
  const info = db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, from_addr, from_name, to_addrs, cc_addrs,
                          subject, snippet, body_text, labels, internal_date, routing_headers)
    VALUES (@gmail_id, 't1', @from_addr, @from_name, @to_addrs, @cc_addrs, @subject, @snippet,
            @body_text, @labels, @internal_date, @routing_headers)
  `).run({
    gmail_id: `m${Math.random().toString(36).slice(2)}`,
    from_addr: 'sender@vendor.example', from_name: 'Vendor Sales',
    to_addrs: JSON.stringify([HONG]), cc_addrs: '[]',
    subject: 'Invoice 42', snippet: 'invoice', body_text: 'Payment is due Friday.',
    labels: JSON.stringify(['INBOX', 'UNREAD']), internal_date: Date.now(),
    routing_headers: JSON.stringify({ 'x-gm-original-to': [HONG] }),
    ...over,
  })
  const id = Number(info.lastInsertRowid)
  db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'to')`)
    .run(id, HONG)
  seedMessageState(id, HONG, JSON.parse(String(over.labels ?? '["INBOX","UNREAD"]')))
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as never
}

const rule = (conditions: unknown, actions: unknown = { star: true }, matchType = 'all') =>
  createRule(HONG, { name: `r${Math.random()}`, matchType, conditions, actions })

before(() => {
  migrate()
  db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash, status)
    VALUES ('hong', 'Hong', 'hong', ?, 'x', 'active')
  `).run(HONG)
  categoryId = createCategory(HONG, 'Vendors', 'blue').id
})

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

// ── Operators ───────────────────────────────────────────────────────────────

test('contains matches anywhere in the field', () => {
  const row = insert()
  applyRules(HONG, row, [rule([{ field: 'subject', op: 'contains', value: 'voice' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)
})

test('contains is case-insensitive', () => {
  const row = insert({ subject: 'URGENT Notice' })
  applyRules(HONG, row, [rule([{ field: 'subject', op: 'contains', value: 'urgent' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)
})

test('notContains is the negation, and fires when the text is absent', () => {
  const row = insert({ subject: 'Newsletter' })
  applyRules(HONG, row, [rule([{ field: 'subject', op: 'notContains', value: 'invoice' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)
})

test('notContains does not fire when the text is present', () => {
  const row = insert({ subject: 'Invoice 99' })
  applyRules(HONG, row, [rule([{ field: 'subject', op: 'notContains', value: 'invoice' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, false)
})

test('equals demands the whole field, not a fragment', () => {
  const exact = insert({ subject: 'Weekly report' })
  const longer = insert({ subject: 'Weekly report for March' })
  const r = rule([{ field: 'subject', op: 'equals', value: 'weekly report' }])
  applyRules(HONG, exact, [r])
  applyRules(HONG, longer, [r])
  assert.equal(messageStateFor((exact as { id: number }).id, HONG).starred, true)
  assert.equal(messageStateFor((longer as { id: number }).id, HONG).starred, false,
    'equals matched a longer subject')
})

test('startsWith and endsWith anchor to their own end', () => {
  const row = insert({ subject: 'Re: budget draft' })
  applyRules(HONG, row, [rule([{ field: 'subject', op: 'startsWith', value: 're:' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)

  const other = insert({ subject: 'quarterly budget draft' })
  applyRules(HONG, other, [rule([{ field: 'subject', op: 'endsWith', value: 'draft' }])])
  assert.equal(messageStateFor((other as { id: number }).id, HONG).starred, true)

  const miss = insert({ subject: 'draft budget quarterly' })
  applyRules(HONG, miss, [rule([{ field: 'subject', op: 'endsWith', value: 'draft' }])])
  assert.equal(messageStateFor((miss as { id: number }).id, HONG).starred, false)
})

// ── Fields ──────────────────────────────────────────────────────────────────

test('from matches the display name as well as the address', () => {
  const row = insert({ from_name: 'Vendor Sales', from_addr: 'noreply@vendor.example' })
  applyRules(HONG, row, [rule([{ field: 'from', op: 'contains', value: 'vendor sales' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)
})

test('body matches the text of the message', () => {
  const row = insert({ body_text: 'Please review the attached contract.' })
  applyRules(HONG, row, [rule([{ field: 'body', op: 'contains', value: 'contract' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)
})

test('recipient reaches the envelope address a bcc would hide', () => {
  // Nothing in to or cc names hong; only the routing header does.
  const row = insert({
    to_addrs: JSON.stringify(['someone@else.example']),
    cc_addrs: '[]',
    routing_headers: JSON.stringify({ 'x-gm-original-to': ['hidden@example.com'] }),
  })
  applyRules(HONG, row, [rule([{ field: 'recipient', op: 'contains', value: 'hidden@example.com' }])])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)

  const viaTo = insert({ to_addrs: JSON.stringify(['someone@else.example']) })
  applyRules(HONG, viaTo, [rule([{ field: 'to', op: 'contains', value: 'hidden@example.com' }])])
  assert.equal(messageStateFor((viaTo as { id: number }).id, HONG).starred, false,
    'the to field should not see the envelope recipient')
})

// ── Combining ───────────────────────────────────────────────────────────────

test('match all requires every condition', () => {
  const row = insert({ subject: 'Invoice 42', from_addr: 'billing@vendor.example' })
  const both = rule([
    { field: 'subject', op: 'contains', value: 'invoice' },
    { field: 'from', op: 'contains', value: 'billing@' },
  ], { star: true }, 'all')
  applyRules(HONG, row, [both])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)

  const missOne = insert({ subject: 'Invoice 43', from_addr: 'other@vendor.example' })
  applyRules(HONG, missOne, [both])
  assert.equal(messageStateFor((missOne as { id: number }).id, HONG).starred, false)
})

test('match any needs only one condition', () => {
  const row = insert({ subject: 'Nothing relevant', from_addr: 'billing@vendor.example' })
  applyRules(HONG, row, [rule([
    { field: 'subject', op: 'contains', value: 'invoice' },
    { field: 'from', op: 'contains', value: 'billing@' },
  ], { star: true }, 'any')])
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, true)
})

// ── Actions ─────────────────────────────────────────────────────────────────

test('every action lands, including the category', () => {
  const row = insert()
  applyRules(HONG, row, [rule(
    [{ field: 'subject', op: 'contains', value: 'invoice' }],
    { categoryId, read: true, star: true, archive: true },
  )])
  const id = (row as { id: number }).id
  const state = messageStateFor(id, HONG)
  assert.deepEqual([state.read, state.starred, state.archived], [true, true, true])
  assert.deepEqual(categoryIdsFor(id, HONG), [categoryId])
})

test('an archived message leaves the inbox and appears in the archive', () => {
  const row = insert({ subject: 'Archive me' })
  applyRules(HONG, row, [rule(
    [{ field: 'subject', op: 'contains', value: 'archive me' }], { archive: true },
  )])
  const gmailId = (row as { gmail_id: string }).gmail_id
  assert.ok(!listMailbox(HONG, 'inbox').some((m) => m.gmail_id === gmailId))
  assert.ok(listMailbox(HONG, 'archive').some((m) => m.gmail_id === gmailId))
})

test('a disabled rule does nothing', () => {
  // This is the one test that reads the stored rules rather than being handed
  // them, so the table has to hold only the rule under test.
  db.prepare(`DELETE FROM rules`).run()
  const created = rule([{ field: 'subject', op: 'contains', value: 'invoice' }])
  setRuleEnabled(HONG, created.id, false)
  const row = insert()
  applyRules(HONG, row)          // reads the stored rules, honouring `enabled`
  assert.equal(messageStateFor((row as { id: number }).id, HONG).starred, false)
  deleteRule(HONG, created.id)
})

test('rules fire in order and the later one wins a contested flag', () => {
  const row = insert({ subject: 'Ordered' })
  const first = rule([{ field: 'subject', op: 'contains', value: 'ordered' }], { read: true })
  const second = rule([{ field: 'subject', op: 'contains', value: 'ordered' }], { archive: true })
  const fired = applyRules(HONG, row, [first, second])
  assert.equal(fired.length, 2, 'both matching rules should report having fired')
  const state = messageStateFor((row as { id: number }).id, HONG)
  assert.deepEqual([state.read, state.archived], [true, true])
})

// ── Ownership ───────────────────────────────────────────────────────────────

test("a rule belongs to its author and is invisible to anyone else", () => {
  const created = rule([{ field: 'subject', op: 'contains', value: 'invoice' }])
  assert.ok(listRules(HONG).some((r) => r.id === created.id))
  assert.deepEqual(listRules(KIM), [], "another member could see someone else's rules")
  assert.throws(() => deleteRule(KIM, created.id), /찾을 수 없|No such/)
  assert.throws(() => setRuleEnabled(KIM, created.id, false), /찾을 수 없|No such/)
  deleteRule(HONG, created.id)
})

test('a rule cannot file into a category it does not own', () => {
  assert.throws(
    () => createRule(KIM, {
      name: 'borrowed', matchType: 'all',
      conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
      actions: { categoryId },
    }),
    /카테고리|category/i,
  )
})

// ── Validation ──────────────────────────────────────────────────────────────

test('malformed rules are refused', () => {
  const base = { name: 'r', matchType: 'all', actions: { star: true } }
  assert.throws(() => createRule(HONG, { ...base, conditions: [] }), /조건|condition/i)
  assert.throws(() => createRule(HONG, {
    ...base, conditions: [{ field: 'nope', op: 'contains', value: 'x' }],
  }), /항목|field/i)
  assert.throws(() => createRule(HONG, {
    ...base, conditions: [{ field: 'subject', op: 'regex', value: 'x' }],
  }), /연산자|operator/i)
  assert.throws(() => createRule(HONG, {
    ...base, conditions: [{ field: 'subject', op: 'contains', value: '   ' }],
  }), /값|value/i)
  assert.throws(() => createRule(HONG, {
    name: '  ', matchType: 'all',
    conditions: [{ field: 'subject', op: 'contains', value: 'x' }], actions: { star: true },
  }), /이름|name/i)
  assert.throws(() => createRule(HONG, {
    ...base, conditions: [{ field: 'subject', op: 'contains', value: 'x' }], actions: {},
  }), /동작|action/i)
  assert.throws(() => createRule(HONG, {
    ...base,
    conditions: Array.from({ length: 11 }, () => ({ field: 'subject', op: 'contains', value: 'x' })),
  }), /10|조건|condition/i)
})

test('an unknown match type falls back to all rather than being accepted', () => {
  const created = createRule(HONG, {
    name: 'fallback', matchType: 'sometimes',
    conditions: [{ field: 'subject', op: 'contains', value: 'x' }], actions: { star: true },
  })
  assert.equal(created.matchType, 'all')
  deleteRule(HONG, created.id)
})

// ── Replaying over existing mail ────────────────────────────────────────────

test('applying to existing mail reports what it scanned and changed', () => {
  db.prepare(`DELETE FROM rules`).run()
  db.prepare(`DELETE FROM message_categories`).run()
  db.prepare(`UPDATE message_state SET is_starred = 0`).run()

  insert({ subject: 'Replay target', labels: JSON.stringify(['INBOX', 'UNREAD']) })
  createRule(HONG, {
    name: 'replay', matchType: 'all',
    conditions: [{ field: 'subject', op: 'contains', value: 'replay target' }],
    actions: { categoryId, star: true },
  })

  const result = applyRulesToExisting(HONG)
  assert.ok(result.scanned > 0, 'nothing was scanned')
  assert.equal(result.changed, 1, `expected one change, got ${result.changed}`)
  assert.equal(listCategories(HONG).find((c) => c.id === categoryId)?.count, 1)
})

test('replaying with no rules is a no-op rather than a full scan', () => {
  db.prepare(`DELETE FROM rules`).run()
  assert.deepEqual(applyRulesToExisting(HONG), { scanned: 0, changed: 0 })
})
