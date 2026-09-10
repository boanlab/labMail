import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo, Server } from 'node:net'

const dir = mkdtempSync(join(tmpdir(), 'labmail-routes-'))
process.env.ADMIN_PASSWORD = 'route-test-admin-password'
process.env.ADMIN_USERNAME = 'admin'
process.env.DATABASE_PATH = join(dir, 'routes.db')
// Set, so dotenv leaves it alone: a deployment .env on the test host
// would otherwise pin the redirect URI to that deployment's hostname.
process.env.PUBLIC_URL = ''

const { start } = await import('../src/web/server.ts')
const { db } = await import('../src/db/index.ts')
const { setSettings } = await import('../src/core/settings.ts')
const { hashPassword } = await import('../src/core/auth.ts')

let base: string
let server: Server
let adminCookie = ''
let memberCookie = ''

interface Response { status: number; body: any; headers: Headers }

async function call(
  path: string,
  { method = 'GET', cookie = '', body }: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* html or redirect */ }
  return { status: res.status, body: parsed, headers: res.headers }
}

const cookieFrom = (res: Response) =>
  (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

before(async () => {
  server = await start(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  setSettings({ org_domain: 'example.com', shared_account_email: 'shared@example.com' })

  db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash,
                       status, provisioned)
    VALUES ('hong', 'Hong', 'hong', 'hong@example.com', ?, 'active', 1)
  `).run(await hashPassword('member-password-1'))

  adminCookie = cookieFrom(await call('/api/login', {
    method: 'POST', body: { username: 'admin', password: 'route-test-admin-password' },
  }))
  memberCookie = cookieFrom(await call('/api/login', {
    method: 'POST', body: { username: 'hong', password: 'member-password-1' },
  }))
  assert.ok(adminCookie && memberCookie, 'both sign-ins must succeed')

  // The bootstrap admin holds no mailbox, which several checks rely on.
  db.prepare(`UPDATE users SET alias_email = NULL WHERE username = 'admin'`).run()
})

after(() => {
  server.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── Authorization matrix ────────────────────────────────────────────────────
const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/settings'],
  ['GET', '/api/admin/unassigned'],
  ['POST', '/api/admin/assign'],
  ['POST', '/api/admin/settings'],
  ['POST', '/api/admin/self-alias'],
  ['GET', '/api/admin/oauth/start'],
  ['GET', '/api/admin/oauth/callback'],
  ['POST', '/api/admin/oauth/disconnect'],
  ['POST', '/api/admin/users/1/approve'],
]

const MAIL_ROUTES: [string, string][] = [
  ['GET', '/api/messages'],
  ['GET', '/api/messages/anything'],
  ['POST', '/api/messages/anything/action'],
  ['GET', '/api/messages/anything/attachments/att1'],
  ['POST', '/api/messages/bulk'],
  ['POST', '/api/send'],
  ['POST', '/api/drafts'],
  ['POST', '/api/drafts/abc/send'],
  ['POST', '/api/drafts/abc/discard'],
  ['GET', '/api/contacts'],
  ['POST', '/api/send/abc/cancel'],
  ['GET', '/api/drive'],
  ['GET', '/api/drive/usage'],
  ['GET', '/api/drive/cached'],
  ['POST', '/api/drive/folder'],
  ['POST', '/api/drive/upload'],
  ['POST', '/api/drive/abc/rename'],
  ['POST', '/api/drive/abc/trash'],
  ['GET', '/api/drive/abc/download'],
  ['POST', '/api/drive/abc/link'],
]

test('every admin route rejects an anonymous caller', async () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const res = await call(path, { method })
    assert.equal(res.status, 401, `${method} ${path} must require a session`)
  }
})

test('every admin route rejects a non-admin member', async () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const res = await call(path, { method, cookie: memberCookie })
    assert.equal(res.status, 403, `${method} ${path} must be admin-only`)
  }
})

test('every mail route rejects an anonymous caller', async () => {
  for (const [method, path] of MAIL_ROUTES) {
    const res = await call(path, { method })
    assert.equal(res.status, 401, `${method} ${path} must require a session`)
  }
})

test('mail routes refuse an account without a mailbox rather than defaulting', async () => {
  // The admin has no alias; an unscoped read here would expose everything.
  for (const [method, path] of MAIL_ROUTES) {
    const res = await call(path, { method, cookie: adminCookie })
    assert.equal(res.status, 409, `${method} ${path} must refuse an alias-less account`)
  }
})

test('a member cannot reach another member\'s message by id', async () => {
  db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, from_addr, to_addrs, subject, snippet, labels, internal_date)
    VALUES ('secret', 't', 'x@y.com', '[]', 'Secret', '', '["INBOX"]', 1)
  `).run()
  const id = db.prepare(`SELECT id FROM messages WHERE gmail_id = 'secret'`).get() as { id: number }
  db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, 'someone@example.com', 'to')`)
    .run(id.id)

  const res = await call('/api/messages/secret', { cookie: memberCookie })
  assert.equal(res.status, 404)
})

// ── Input handling ──────────────────────────────────────────────────────────
test('draft routes reject an address that could inject headers', async () => {
  const res = await call('/api/drafts', {
    method: 'POST', cookie: memberCookie,
    body: { to: ['a@b.com\r\nBcc: x@evil.net'], subject: 's', bodyText: 'b' },
  })
  assert.equal(res.status, 400)
})

test('a member with no send-as entry cannot send at all', async () => {
  db.prepare(`UPDATE users SET provisioned = 0 WHERE username = 'hong'`).run()
  try {
    // Gmail rewrites From to the shared account when the address has no
    // send-as entry, so letting this through publishes the shared mailbox
    // under the member's name. Both ways of putting a message on the wire
    // have to refuse, not just the composer.
    const sent = await call('/api/send', {
      method: 'POST', cookie: memberCookie,
      body: { to: ['someone@example.com'], subject: 'x', bodyText: 'x' },
    })
    assert.equal(sent.status, 409, 'send must refuse')

    const draft = await call('/api/drafts/whatever/send', { method: 'POST', cookie: memberCookie })
    assert.equal(draft.status, 409, 'sending a draft must refuse too')

    // Reading is unaffected: the member still has a mailbox.
    const list = await call('/api/messages?mailbox=inbox', { cookie: memberCookie })
    assert.equal(list.status, 200, 'reading must still work')
  } finally {
    db.prepare(`UPDATE users SET provisioned = 1 WHERE username = 'hong'`).run()
  }
})

test('a member cannot address a draft they do not own', async () => {
  db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, gmail_draft_id, from_addr, to_addrs,
                          subject, snippet, labels, internal_date)
    VALUES ('dm1', 'dt1', 'draft-other', 'other@example.com', '[]', 'Theirs', '', '["DRAFT"]', 1)
  `).run()
  const row = db.prepare(`SELECT id FROM messages WHERE gmail_id = 'dm1'`).get() as { id: number }
  db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, 'other@example.com', 'from')`)
    .run(row.id)

  for (const path of ['/api/drafts/draft-other/send', '/api/drafts/draft-other/discard']) {
    const res = await call(path, { method: 'POST', cookie: memberCookie })
    assert.equal(res.status, 404, `${path} must not reveal another member's draft`)
  }
})

test('a signature is stored sanitized and returned with the session', async () => {
  await call('/api/profile/signature', {
    method: 'POST', cookie: memberCookie,
    body: { signature: '<p>Hong<script>evil()</script> <a href="javascript:x">bad</a></p>' },
  })
  const me = await call('/api/me', { cookie: memberCookie })
  const signature = me.body.user.signature as string
  assert.ok(!/script|javascript:/i.test(signature), signature)
  assert.ok(signature.includes('Hong'))
})

test('a member cannot set another account\'s signature', async () => {
  // The route takes the id from the session, so there is no id to tamper with.
  const before = (await call('/api/me', { cookie: adminCookie })).body.user.signature
  await call('/api/profile/signature', {
    method: 'POST', cookie: memberCookie, body: { signature: '<p>mine</p>' },
  })
  const after = (await call('/api/me', { cookie: adminCookie })).body.user.signature
  assert.equal(after, before, "the admin's signature is untouched")
})

test('recalling a send that was never held is refused', async () => {
  const res = await call('/api/send/nonexistent/cancel', { method: 'POST', cookie: memberCookie })
  assert.equal(res.status, 409)
})

test('rejects unknown mailboxes and filters', async () => {
  for (const query of ['mailbox=../etc', 'mailbox=everything', 'filter=all;drop']) {
    const res = await call(`/api/messages?${query}`, { cookie: memberCookie })
    assert.equal(res.status, 400, query)
  }
})

test('accepts every mailbox the client can select', async () => {
  for (const mailbox of ['inbox', 'sent', 'archive', 'trash', 'spam', 'drafts']) {
    const res = await call(`/api/messages?mailbox=${mailbox}`, { cookie: memberCookie })
    assert.equal(res.status, 200, mailbox)
    assert.ok(Array.isArray(res.body.messages))
  }
})

test('rejects malformed JSON and unknown actions', async () => {
  const bad = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
  })
  assert.equal(bad.status, 400)

  const res = await call('/api/messages/x/action', {
    method: 'POST', cookie: memberCookie, body: { action: 'destroy' },
  })
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`)
})

test('rejects addresses that could inject headers, before reaching Google', async () => {
  const res = await call('/api/send', {
    method: 'POST', cookie: memberCookie,
    body: { to: ['ok@other.org\r\nBcc: attacker@evil.net'], subject: 'x', bodyText: 'y' },
  })
  assert.equal(res.status, 400)
})

test('distinguishes an unknown path from a wrong method', async () => {
  assert.equal((await call('/nope')).status, 404)
  assert.equal((await call('/healthz', { method: 'POST' })).status, 405)
})

// ── Session behaviour ───────────────────────────────────────────────────────
test('signing out invalidates the session immediately', async () => {
  const cookie = cookieFrom(await call('/api/login', {
    method: 'POST', body: { username: 'hong', password: 'member-password-1' },
  }))
  assert.equal((await call('/api/me', { cookie })).body.user.username, 'hong')

  await call('/api/logout', { method: 'POST', cookie })
  assert.equal((await call('/api/me', { cookie })).body.user, null)
})

test('deactivating an account invalidates its live session', async () => {
  const cookie = cookieFrom(await call('/api/login', {
    method: 'POST', body: { username: 'hong', password: 'member-password-1' },
  }))
  assert.ok((await call('/api/me', { cookie })).body.user)

  db.prepare(`UPDATE users SET status = 'deactivated' WHERE username = 'hong'`).run()
  assert.equal((await call('/api/me', { cookie })).body.user, null)
  assert.equal((await call('/api/messages', { cookie })).status, 401)

  db.prepare(`UPDATE users SET status = 'active' WHERE username = 'hong'`).run()
})

test('a forged session cookie is not accepted', async () => {
  const res = await call('/api/me', { cookie: 'labmail_session=made-up-token' })
  assert.equal(res.body.user, null)
})

test('login does not reveal whether a username exists', async () => {
  const missing = await call('/api/login', { method: 'POST', body: { username: 'nobody', password: 'x' } })
  const wrong = await call('/api/login', { method: 'POST', body: { username: 'hong', password: 'x' } })
  assert.equal(missing.status, 401)
  assert.equal(wrong.status, 401)
  assert.deepEqual(missing.body, wrong.body)
})

// ── OAuth ───────────────────────────────────────────────────────────────────
test('the OAuth callback refuses a forged state', async () => {
  const res = await call('/api/admin/oauth/callback?code=x&state=forged', { cookie: adminCookie })
  assert.equal(res.status, 400)
})

test('starting OAuth without stored credentials is refused', async () => {
  const res = await call('/api/admin/oauth/start', { cookie: adminCookie })
  assert.equal(res.status, 409)
})

// ── Public surface ──────────────────────────────────────────────────────────
test('the public config never leaks configuration state', async () => {
  const res = await call('/api/config')
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(res.body).sort(), ['locale', 'locales', 'orgDomain'])
})

test('settings never return secret values', async () => {
  await call('/api/admin/settings', {
    method: 'POST', cookie: adminCookie,
    body: { google_client_id: 'the-id', google_client_secret: 'the-secret' },
  })
  const res = await call('/api/admin/settings', { cookie: adminCookie })
  const serialized = JSON.stringify(res.body)
  assert.ok(!serialized.includes('the-secret'), 'the secret must never be echoed')
  assert.equal(res.body.settings.google_client_secret, true)
  assert.equal(res.body.settings.google_client_id, 'the-id')
})

test('a blank secret leaves the stored value untouched', async () => {
  await call('/api/admin/settings', {
    method: 'POST', cookie: adminCookie, body: { google_client_secret: '', org_domain: 'example.com' },
  })
  const res = await call('/api/admin/settings', { cookie: adminCookie })
  assert.equal(res.body.settings.google_client_secret, true, 'must still be set')
})

test('the redirect URI follows the host the caller used', async () => {
  const res = await call('/api/admin/settings', { cookie: adminCookie })
  assert.match(res.body.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/api\/admin\/oauth\/callback$/)
})
