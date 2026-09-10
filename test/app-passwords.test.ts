import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'labmail-appwd-'))
process.env.ADMIN_PASSWORD = 'appwd-test-admin-password'
process.env.DATABASE_PATH = join(dir, 'appwd.db')
process.env.MAIL_TRACE = 'false'

const { db, migrate } = await import('../src/db/index.ts')
const { hashPassword } = await import('../src/core/auth.ts')
const { setSettings } = await import('../src/core/settings.ts')
const {
  createAppPassword, listAppPasswords, revokeAppPassword, hasAppPassword, verifyAppPassword,
} = await import('../src/core/app-passwords.ts')
const { verifyMailCredential } = await import('../src/mail/credentials.ts')

let userId: number

before(async () => {
  migrate()
  setSettings({ org_domain: 'example.com', shared_account_email: 'shared@example.com' })
  userId = db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash,
                       status, provisioned)
    VALUES ('hong', 'Hong', 'hong', 'hong@example.com', ?, 'active', 1)
  `).run(await hashPassword('sign-in-password-1')).lastInsertRowid as number
})

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('the sign-in password reaches mail only while no app password exists', async () => {
  assert.equal(hasAppPassword(userId), false)
  const before = await verifyMailCredential('hong@example.com', 'sign-in-password-1')
  assert.equal(before?.alias, 'hong@example.com', 'nothing to move to yet')

  const made = await createAppPassword(userId, 'MacBook')

  // The whole point: the sign-in password stops being a mail credential, so it
  // is not left sitting on every device the member owns.
  const after = await verifyMailCredential('hong@example.com', 'sign-in-password-1')
  assert.equal(after, null, 'the sign-in password must stop working for mail')

  const client = await verifyMailCredential('hong@example.com', made.secret)
  assert.equal(client?.alias, 'hong@example.com')
})

test('a generated secret avoids characters that are read wrong', async () => {
  const { secret } = await createAppPassword(userId, 'Phone')
  assert.match(secret, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/, secret)
  assert.doesNotMatch(secret, /[01lo]/, 'look-alikes are left out')
})

test('the secret is never recoverable from what is stored', async () => {
  const { secret } = await createAppPassword(userId, 'Tablet')
  const stored = db.prepare(`SELECT password_hash FROM app_passwords`).all() as
    { password_hash: string }[]
  assert.ok(stored.every((r) => !r.password_hash.includes(secret)))
  assert.ok(!JSON.stringify(listAppPasswords(userId)).includes(secret))
})

test('use is recorded, so a member can tell which one to revoke', async () => {
  const { id, secret } = await createAppPassword(userId, 'Desktop')
  assert.equal(listAppPasswords(userId).find((p) => p.id === id)?.lastUsedAt, null)
  assert.equal(await verifyAppPassword(userId, secret), true)
  assert.ok(listAppPasswords(userId).find((p) => p.id === id)?.lastUsedAt)
})

test('revoking one leaves the others working', async () => {
  const keep = await createAppPassword(userId, 'Keep')
  const drop = await createAppPassword(userId, 'Drop')

  assert.equal(revokeAppPassword(userId, drop.id), true)
  assert.equal(await verifyMailCredential('hong@example.com', drop.secret), null)
  assert.ok(await verifyMailCredential('hong@example.com', keep.secret))

  // Another member cannot revoke it, even knowing the id.
  assert.equal(revokeAppPassword(userId + 999, keep.id), false)
})

test('an unlabelled password is refused', async () => {
  // The message is already translated; the key is what identifies it.
  await assert.rejects(
    () => createAppPassword(userId, '   '),
    (err: Error & { key?: string }) => err.key === 'appPassword.noLabel',
  )
})
