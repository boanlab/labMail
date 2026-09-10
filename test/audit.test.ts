import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'labmail-audit-'))
process.env.ADMIN_PASSWORD = 'test-admin-password'
process.env.DATABASE_PATH = join(dir, 'test.db')

const { db, migrate } = await import('../src/db/index.ts')
const { audit, listAudit, auditFacets, pruneAudit, auditSize } =
  await import('../src/core/audit.ts')

before(() => { migrate() })
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('an entry records the actor, the action and what was touched', () => {
  audit({ actor: 'hong@example.com', actorId: 1, action: 'message.read', target: 'm1', ip: '10.0.0.5' })
  const { rows } = listAudit({ action: 'message.read' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.actor, 'hong@example.com')
  assert.equal(rows[0]!.target, 'm1')
  assert.equal(rows[0]!.ip, '10.0.0.5')
})

test('detail is stored as JSON and carries no message content', () => {
  audit({ actor: 'hong@example.com', action: 'message.send', target: 'm2',
          detail: { to: 2, cc: 0, bcc: 1, attachments: 3 } })
  const { rows } = listAudit({ action: 'message.send' })
  assert.deepEqual(JSON.parse(rows[0]!.detail!), { to: 2, cc: 0, bcc: 1, attachments: 3 })
})

test('a failed write never propagates to the caller', () => {
  // The column is NOT NULL; the insert fails and the caller must not notice.
  assert.doesNotThrow(() => audit({ action: undefined as unknown as 'signin.ok' }))
})

test('entries come back newest first', () => {
  db.prepare(`DELETE FROM audit_log`).run()
  db.prepare(`INSERT INTO audit_log (at, actor, action) VALUES ('2026-01-01 00:00:00', 'a', 'signin.ok')`).run()
  db.prepare(`INSERT INTO audit_log (at, actor, action) VALUES ('2026-06-01 00:00:00', 'b', 'signin.ok')`).run()
  const { rows } = listAudit({})
  assert.deepEqual(rows.map((r) => r.actor), ['b', 'a'])
})

test('filters narrow by actor, action and date', () => {
  db.prepare(`DELETE FROM audit_log`).run()
  audit({ actor: 'hong@example.com', action: 'message.read', target: 'm1' })
  audit({ actor: 'kim@example.com', action: 'message.read', target: 'm2' })
  audit({ actor: 'hong@example.com', action: 'signin.ok' })

  assert.equal(listAudit({ actor: 'hong@example.com' }).rows.length, 2)
  assert.equal(listAudit({ action: 'message.read' }).rows.length, 2)
  assert.equal(listAudit({ actor: 'hong@example.com', action: 'message.read' }).rows.length, 1)
  assert.equal(listAudit({ since: '2099-01-01' }).rows.length, 0)
})

test('paging reports whether more remains', () => {
  db.prepare(`DELETE FROM audit_log`).run()
  for (let i = 0; i < 5; i++) audit({ actor: 'hong@example.com', action: 'message.read', target: `m${i}` })
  const first = listAudit({ limit: 2 })
  assert.equal(first.rows.length, 2)
  assert.equal(first.hasMore, true)
  const last = listAudit({ limit: 2, offset: 4 })
  assert.equal(last.rows.length, 1)
  assert.equal(last.hasMore, false)
})

test('the limit is clamped rather than trusted', () => {
  const { rows } = listAudit({ limit: 100_000 })
  assert.ok(rows.length <= 500)
})

test('facets list the actors and actions actually present', () => {
  db.prepare(`DELETE FROM audit_log`).run()
  audit({ actor: 'hong@example.com', action: 'message.read' })
  audit({ actor: 'kim@example.com', action: 'signin.ok' })
  audit({ action: 'signin.fail' })            // anonymous
  const facets = auditFacets()
  assert.deepEqual(facets.actors, ['hong@example.com', 'kim@example.com'])
  assert.deepEqual(facets.actions, ['message.read', 'signin.fail', 'signin.ok'])
})

test('pruning drops entries past the window and keeps the rest', () => {
  db.prepare(`DELETE FROM audit_log`).run()
  db.prepare(`INSERT INTO audit_log (at, actor, action) VALUES (datetime('now', '-400 days'), 'old', 'signin.ok')`).run()
  db.prepare(`INSERT INTO audit_log (at, actor, action) VALUES (datetime('now', '-2 days'), 'new', 'signin.ok')`).run()

  const dropped = pruneAudit(365)
  assert.equal(dropped, 1)
  assert.equal(auditSize(), 1)
  assert.equal(listAudit({}).rows[0]!.actor, 'new')
})

test('a retention of zero keeps everything', () => {
  const before = auditSize()
  assert.equal(pruneAudit(0), 0)
  assert.equal(auditSize(), before)
})
