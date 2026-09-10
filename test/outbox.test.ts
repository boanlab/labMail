import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'labmail-outbox-'))
process.env.ADMIN_PASSWORD = 'outbox-test-password'
process.env.DATABASE_PATH = join(dir, 'outbox.db')

const { db } = await import('../src/db/index.ts')
const { setSettings } = await import('../src/core/settings.ts')
const { hold, cancel, resumeHeldSends, stopAllTimers } = await import('../src/google/outbox.ts')
const { undoSendSeconds } = await import('../src/core/settings.ts')

const held = () => db.prepare(`SELECT id, alias, draft_id FROM pending_sends`).all() as
  { id: string; alias: string; draft_id: string | null }[]

before(() => {
  setSettings({ org_domain: 'example.com', shared_account_email: 'shared@example.com',
                undo_send_seconds: '30' })
})

after(() => {
  stopAllTimers()
  db.prepare(`DELETE FROM pending_sends`).run()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('holding a message queues it with the configured window', () => {
  const { pendingId, undoSeconds } = hold('hong@example.com', 'cmF3', {})
  assert.equal(undoSeconds, 30)
  assert.ok(pendingId)
  assert.equal(held().length, 1)
  assert.ok(cancel('hong@example.com', pendingId))
})

test('cancelling removes the hold so nothing is sent', () => {
  const { pendingId } = hold('hong@example.com', 'cmF3', {})
  assert.equal(cancel('hong@example.com', pendingId), true)
  assert.equal(held().length, 0)
})

test('a member cannot recall another member\'s send', () => {
  const { pendingId } = hold('hong@example.com', 'cmF3', {})
  assert.equal(cancel('kim@example.com', pendingId), false, 'must not cancel')
  assert.equal(held().length, 1, 'the hold survives the attempt')
  assert.ok(cancel('hong@example.com', pendingId))
})

test('cancelling twice reports the window has closed', () => {
  const { pendingId } = hold('hong@example.com', 'cmF3', {})
  assert.equal(cancel('hong@example.com', pendingId), true)
  assert.equal(cancel('hong@example.com', pendingId), false)
})

test('an unknown handle cannot be cancelled', () => {
  assert.equal(cancel('hong@example.com', 'made-up-handle'), false)
})

test('the thread and draft it belongs to are remembered', () => {
  const { pendingId } = hold('hong@example.com', 'cmF3', { threadId: 't1', draftId: 'd1' })
  const row = db.prepare(`SELECT thread_id, draft_id FROM pending_sends WHERE id = ?`)
    .get(pendingId) as { thread_id: string; draft_id: string }
  assert.equal(row.thread_id, 't1')
  assert.equal(row.draft_id, 'd1')
  assert.ok(cancel('hong@example.com', pendingId))
})

test('holds survive a restart and are re-armed', () => {
  const a = hold('hong@example.com', 'cmF3', {})
  const b = hold('kim@example.com', 'cmF3', {})
  // resumeHeldSends is what a fresh process calls; the rows are still owed.
  assert.equal(resumeHeldSends(), 2)
  assert.equal(held().length, 2)
  assert.ok(cancel('hong@example.com', a.pendingId))
  assert.ok(cancel('kim@example.com', b.pendingId))
})

test('the configured window is clamped to a sane range', () => {
  // Read through the setting rather than by holding a message: a zero-second
  // hold would fire immediately, and the route never asks for one.
  setSettings({ undo_send_seconds: '999' })
  assert.equal(undoSendSeconds(), 60, 'capped')

  setSettings({ undo_send_seconds: '-5' })
  assert.equal(undoSendSeconds(), 10, 'a negative value falls back to the default')

  setSettings({ undo_send_seconds: 'abc' })
  assert.equal(undoSendSeconds(), 10, 'a non-numeric value falls back to the default')

  setSettings({ undo_send_seconds: '0' })
  assert.equal(undoSendSeconds(), 0, 'zero disables the window')

  setSettings({ undo_send_seconds: '30' })
  assert.equal(undoSendSeconds(), 30)
})
