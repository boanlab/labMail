import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo, Server } from 'node:net'

const dir = mkdtempSync(join(tmpdir(), 'labmail-smtp-'))
process.env.ADMIN_PASSWORD = 'smtp-test-admin-password'
process.env.DATABASE_PATH = join(dir, 'smtp.db')

const { db, migrate } = await import('../src/db/index.ts')
const { hashPassword } = await import('../src/core/auth.ts')
const { setSettings } = await import('../src/core/settings.ts')
const { rewriteSubmission } = await import('../src/mail/rewrite.ts')
const { verifyMailCredential } = await import('../src/mail/credentials.ts')
const { startSmtp } = await import('../src/mail/smtp.ts')

let server: Server
let port: number

before(async () => {
  migrate()
  setSettings({
    org_domain: 'example.com', shared_account_email: 'shared@example.com',
    google_client_id: 'id', google_client_secret: 'secret', google_refresh_token: 'token',
  })
  const insert = db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash,
                       status, provisioned)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `)
  insert.run('hong', 'Hong Gil-dong', 'hong', 'hong@example.com', await hashPassword('hong-password-1'), 1)
  insert.run('kim', 'Kim', 'kim', 'kim@example.com', await hashPassword('kim-password-1'), 0)

  server = await startSmtp(0)
  port = (server.address() as AddressInfo).port
})

after(() => {
  server?.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Drive one session, returning every line the server sent. */
function session(script: (send: (line: string) => void) => void): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let buffer = ''
    let greeted = false
    const socket: Socket = connect(port, '127.0.0.1')
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('timed out')) })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        lines.push(buffer.slice(0, at))
        buffer = buffer.slice(at + 2)
      }
      // The server speaks first. Waiting for it is what a real client does,
      // and a harness that does not would not notice a server that never did.
      if (!greeted) {
        greeted = true
        assert.ok(lines[0]?.startsWith('220'), `expected a greeting, got ${lines[0]}`)
        script((line) => socket.write(line + '\r\n'))
      }
    })
    socket.on('close', () => resolve(lines))
    socket.on('error', reject)
  })
}

const plain = (user: string, pass: string) =>
  Buffer.from(`\0${user}\0${pass}`).toString('base64')

const codes = (lines: string[]) => lines.map((l) => l.slice(0, 3))

test('a session must authenticate before it may name a sender', async () => {
  const lines = await session((send) => {
    send('EHLO client')
    send('MAIL FROM:<hong@example.com>')
    send('QUIT')
  })
  assert.ok(lines.some((l) => l.startsWith('530')), 'MAIL without AUTH must be refused')
})

test('AUTH PLAIN accepts a member and refuses a wrong password', async () => {
  const good = await session((send) => {
    send('EHLO client')
    send(`AUTH PLAIN ${plain('hong@example.com', 'hong-password-1')}`)
    send('QUIT')
  })
  assert.ok(good.some((l) => l.startsWith('235')), 'correct password must authenticate')

  const bad = await session((send) => {
    send('EHLO client')
    send(`AUTH PLAIN ${plain('hong@example.com', 'wrong')}`)
    send('QUIT')
  })
  assert.ok(bad.some((l) => l.startsWith('535')), 'wrong password must be refused')
})

test('a member with no send-as entry is refused at MAIL', async () => {
  const lines = await session((send) => {
    send('EHLO client')
    send(`AUTH PLAIN ${plain('kim@example.com', 'kim-password-1')}`)
    send('MAIL FROM:<kim@example.com>')
    send('QUIT')
  })
  assert.ok(lines.some((l) => l.startsWith('235')), 'authentication still succeeds')
  assert.ok(lines.some((l) => l.startsWith('550')), 'sending is refused')
})

test('a submitted message is queued and held for the undo window', async () => {
  const lines = await session((send) => {
    send('EHLO client')
    send(`AUTH PLAIN ${plain('hong@example.com', 'hong-password-1')}`)
    send('MAIL FROM:<hong@example.com>')
    send('RCPT TO:<outside@example.org>')
    send('DATA')
    send('From: Someone Else <evil@example.org>')
    send('To: outside@example.org')
    send('Subject: hello')
    send('')
    send('body')
    send('.')
    send('QUIT')
  })
  assert.ok(lines.some((l) => l.startsWith('250 2.0.0 Queued')), codes(lines).join(','))

  const row = db.prepare(`SELECT alias, raw FROM pending_sends`).get() as
    { alias: string; raw: string }
  assert.equal(row.alias, 'hong@example.com')
  const raw = Buffer.from(row.raw, 'base64url').toString()
  assert.match(raw, /^From: Hong Gil-dong <hong@example\.com>/, 'From is the authenticated member')
  assert.doesNotMatch(raw, /evil@example\.org/, "the client's own From is discarded")
  db.prepare(`DELETE FROM pending_sends`).run()
})

test('an envelope recipient no header names becomes a Bcc', () => {
  const { raw, bcc } = rewriteSubmission(
    'From: whoever <x@y.z>\r\nTo: seen@example.org\r\nSubject: s\r\n\r\nbody',
    { alias: 'hong@example.com', displayName: 'Hong' },
    ['seen@example.org', 'hidden@example.org'],
  )
  assert.deepEqual(bcc, ['hidden@example.org'], 'only the address no header carried')
  assert.match(raw, /Bcc: hidden@example\.org/)
  assert.match(raw, /From: Hong <hong@example\.com>/)
})

test('a client-supplied Bcc header is discarded, not forwarded', () => {
  // Gmail would deliver to it, so a client that leaves one in must not be able
  // to reach an address the envelope never named.
  const { raw, bcc } = rewriteSubmission(
    'From: x@y.z\r\nTo: seen@example.org\r\nBcc: sneaky@example.org\r\n\r\nbody',
    { alias: 'hong@example.com', displayName: 'Hong' },
    ['seen@example.org'],
  )
  assert.deepEqual(bcc, [])
  assert.doesNotMatch(raw, /sneaky@example\.org/)
})

test('folded headers and the body survive the rewrite intact', () => {
  const { raw } = rewriteSubmission(
    'From: x@y.z\r\nTo: a@example.org,\r\n b@example.org\r\nSubject: s\r\n\r\nline one\r\n.stuffed\r\n',
    { alias: 'hong@example.com', displayName: 'Hong' },
    ['a@example.org', 'b@example.org'],
  )
  assert.match(raw, /To: a@example\.org,\r\n b@example\.org/, 'the fold is preserved')
  assert.match(raw, /\r\n\r\nline one\r\n\.stuffed\r\n$/, 'the body is untouched')
  assert.doesNotMatch(raw, /Bcc:/, 'both recipients were visible')
})

test('credentials are refused for an account that cannot receive', async () => {
  assert.equal(await verifyMailCredential('nobody@example.com', 'x'), null)
  assert.equal(await verifyMailCredential('hong@example.com', 'wrong'), null)
  const ok = await verifyMailCredential('hong@example.com', 'hong-password-1')
  assert.equal(ok?.alias, 'hong@example.com')
  assert.equal(ok?.canSend, true)
})
