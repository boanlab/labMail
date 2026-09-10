import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'labmail-imap-'))
process.env.ADMIN_PASSWORD = 'imap-test-admin-password'
process.env.DATABASE_PATH = join(dir, 'imap.db')
// The trace is a diagnostic, not part of what the tests assert on.
process.env.MAIL_TRACE = 'false'

const { db, migrate, setMessageState } = await import('../src/db/index.ts')
const { hashPassword } = await import('../src/core/auth.ts')
const { setSettings } = await import('../src/core/settings.ts')
const { openMailbox } = await import('../src/mail/uid.ts')
const { bodystructure, headerFields, envelope } = await import('../src/mail/rfc822.ts')
const { startImap } = await import('../src/mail/imap.ts')

let server: Server
let port: number
const ids: Record<string, number> = {}

before(async () => {
  migrate()
  setSettings({ org_domain: 'example.com', shared_account_email: 'shared@example.com' })
  db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash,
                       status, provisioned)
    VALUES ('hong', 'Hong', 'hong', 'hong@example.com', ?, 'active', 1)
  `).run(await hashPassword('hong-password-1'))

  const insert = db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, rfc822_id, from_addr, from_name,
                          to_addrs, cc_addrs, subject, snippet, body_text, labels, internal_date)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 's', 'b', ?, ?)
  `)
  const own = db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'to')`)
  for (const [n, subject] of [['a', 'first'], ['b', 'second']] as const) {
    const id = insert.run(
      `g-${n}`, `t-${n}`, `<${n}@example.org>`, 'sender@example.org', 'Sender',
      '["hong@example.com"]', subject, '["INBOX","UNREAD"]', 1_700_000_000_000 + (n === 'a' ? 0 : 1000),
    ).lastInsertRowid as number
    ids[n] = id
    own.run(id, 'hong@example.com')
  }

  server = await startImap(0)
  port = (server.address() as AddressInfo).port
})

after(() => { server?.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

function session(lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = []
    let buffer = ''
    let greeted = false
    let i = 0
    const socket: Socket = connect(port, '127.0.0.1')
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('timed out')) })
    const next = () => { if (i < lines.length) socket.write(lines[i++] + '\r\n') }
    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary')
      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        out.push(line)
        if (!greeted) { greeted = true; assert.match(line, /^\* OK \[CAPABILITY/); next(); continue }
        if (/^a\d+ (OK|NO|BAD)/.test(line) || /^\+ /.test(line)) next()
      }
    })
    socket.on('close', () => resolve(out))
    socket.on('error', reject)
  })
}

test('a mailbox cannot be opened before authenticating', async () => {
  const out = await session(['a1 SELECT INBOX', 'a2 LOGOUT'])
  assert.ok(out.some((l) => /^a1 NO Authenticate first/.test(l)), out.join('\n'))
})

test('LOGIN accepts a member and refuses a wrong password', async () => {
  const ok = await session(['a1 LOGIN hong@example.com hong-password-1', 'a2 LOGOUT'])
  assert.ok(ok.some((l) => /^a1 OK \[CAPABILITY/.test(l)))

  const bad = await session(['a1 LOGIN hong@example.com nope', 'a2 LOGOUT'])
  assert.ok(bad.some((l) => /^a1 NO \[AUTHENTICATIONFAILED\]/.test(l)))
})

test('LIST reports the mailboxes with their special-use attributes', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1', 'a2 LIST "" "*"', 'a3 LOGOUT',
  ])
  assert.ok(out.some((l) => l.includes('"INBOX"')))
  assert.ok(out.some((l) => l.includes('\\Sent') && l.includes('"Sent"')))
  assert.ok(out.some((l) => l.includes('\\Trash')))
})

test('SELECT reports the mailbox as writable, with UIDVALIDITY', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1', 'a2 SELECT INBOX', 'a3 LOGOUT',
  ])
  assert.ok(out.some((l) => l === '* 2 EXISTS'), out.join('\n'))
  assert.ok(out.some((l) => /^\* OK \[UIDVALIDITY \d+\]/.test(l)))
  assert.ok(out.some((l) => /^a2 OK \[READ-WRITE\] SELECT completed/.test(l)))
  assert.ok(out.some((l) => l.includes('PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)')))
})

test('UID FETCH reports flags and envelope without reaching for the original', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    'a3 UID FETCH 1:* (UID FLAGS ENVELOPE)',
    'a4 LOGOUT',
  ])
  const fetched = out.filter((l) => l.includes('FETCH ('))
  assert.equal(fetched.length, 2, out.join('\n'))
  assert.ok(fetched[0]!.includes('UID 1'))
  assert.ok(fetched[0]!.includes('"first"'), fetched[0] ?? '')
  // Nothing is read yet, so no \Seen on either.
  assert.ok(fetched.every((l) => !l.includes('\\Seen')))
})

test('flags follow this member alone', async () => {
  setMessageState(ids.a!, 'hong@example.com', 'is_read', true)
  setMessageState(ids.a!, 'hong@example.com', 'is_starred', true)
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    'a3 UID FETCH 1 (FLAGS)',
    'a4 LOGOUT',
  ])
  const line = out.find((l) => l.includes('FETCH ('))!
  assert.match(line, /\\Seen/)
  assert.match(line, /\\Flagged/)
})

test('UID SEARCH UNSEEN answers from per-member state', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    'a3 UID SEARCH UNSEEN',
    'a4 LOGOUT',
  ])
  const line = out.find((l) => l.startsWith('* SEARCH'))!
  assert.equal(line, '* SEARCH 2', 'only the message this member has not read')
})

test('STORE \\Seen marks the message read for this member', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    'a3 UID STORE 2 +FLAGS (\\Seen)',
    'a4 LOGOUT',
  ])
  assert.ok(out.some((l) => /^a3 OK STORE completed/.test(l)), out.join('\n'))
  assert.ok(out.some((l) => l.includes('FLAGS') && l.includes('\\Seen')))
  const state = db.prepare(
    `SELECT is_read FROM message_state WHERE message_id = ? AND alias = 'hong@example.com'`,
  ).get(ids.b) as { is_read: number }
  assert.equal(state.is_read, 1, 'the web view must agree')
})

test('\\Deleted is held until EXPUNGE, and then removes for this member alone', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    'a3 UID STORE 2 +FLAGS (\\Deleted)',
    'a4 UID FETCH 2 (FLAGS)',
    'a5 EXPUNGE',
    'a6 LOGOUT',
  ])
  // Readable back before anything happens to the message.
  const fetched = out.find((l) => /^\* \d+ FETCH/.test(l) && l.includes('\\Deleted'))
  assert.ok(fetched, out.join('\n'))

  const removed = db.prepare(
    `SELECT is_removed FROM message_state WHERE message_id = ? AND alias = 'hong@example.com'`,
  ).get(ids.b) as { is_removed: number }
  assert.equal(removed.is_removed, 1)
  assert.ok(out.some((l) => /^\* \d+ EXPUNGE/.test(l)))

  // The other member is untouched: removal is per member, not a delete.
  const other = db.prepare(
    `SELECT COUNT(*) AS n FROM message_state WHERE message_id = ? AND is_removed = 1`,
  ).get(ids.b) as { n: number }
  assert.equal(other.n, 1)
})

test('APPEND to Sent is accepted for mail this member sent', async () => {
  // A client files its sent copy with the inbox selected, so the match cannot
  // be scoped to the open mailbox.
  const body = 'Message-ID: <a@example.org>\r\nSubject: s\r\n\r\nbody'
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    `a3 APPEND Sent {${body.length}}`,
    body,
    'a4 LOGOUT',
  ])
  assert.ok(out.some((l) => /^a3 OK \[APPENDUID/.test(l)), out.join('\n'))
})

test('APPEND of mail that never went through labMail is refused', async () => {
  const body = 'Message-ID: <not-ours@example.org>\r\nSubject: s\r\n\r\nbody'
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 SELECT INBOX',
    `a3 APPEND Sent {${body.length}}`,
    body,
    'a4 LOGOUT',
  ])
  assert.ok(out.some((l) => /^a3 NO \[CANNOT\]/.test(l)), out.join('\n'))
})

test('APPEND matches a message still inside its undo window', async () => {
  const { hold } = await import('../src/google/outbox.ts')
  const raw = Buffer.from(
    'Message-ID: <held@example.org>\r\nSubject: s\r\n\r\nbody',
  ).toString('base64url')
  const { pendingId } = hold('hong@example.com', raw)
  try {
    const body = 'Message-ID: <held@example.org>\r\nSubject: s\r\n\r\nbody'
    const out = await session([
      'a1 LOGIN hong@example.com hong-password-1',
      'a2 SELECT INBOX',
      `a3 APPEND Sent {${body.length}}`,
      body,
      'a4 LOGOUT',
    ])
    assert.ok(out.some((l) => /^a3 OK \[APPENDUID/.test(l)), out.join('\n'))
  } finally {
    const { cancel, stopAllTimers } = await import('../src/google/outbox.ts')
    cancel('hong@example.com', pendingId)
    stopAllTimers()
  }
})

test('UIDs are stable across opens and survive a message leaving', () => {
  // Its own member and messages: UID numbering is what is under test, and
  // sharing a mailbox with the tests that empty it would decide the answer.
  db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash,
                       status, provisioned)
    VALUES ('uid', 'Uid', 'uid', 'uid@example.com', 'x', 'active', 1)
  `).run()
  const insert = db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, from_addr, to_addrs, cc_addrs,
                          subject, snippet, body_text, labels, internal_date)
    VALUES (?, ?, 'sender@example.org', '["uid@example.com"]', '[]', 's', 's', 'b',
            '["INBOX"]', ?)
  `)
  const own = db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'to')`)
  const first = insert.run('u-1', 'ut-1', 1_800_000_000_000).lastInsertRowid as number
  const second = insert.run('u-2', 'ut-2', 1_800_000_001_000).lastInsertRowid as number
  own.run(first, 'uid@example.com')
  own.run(second, 'uid@example.com')

  const opened = openMailbox('uid@example.com', 'inbox')
  assert.deepEqual(opened.messages.map((m) => m.uid), [1, 2])

  const again = openMailbox('uid@example.com', 'inbox')
  assert.deepEqual(again.messages.map((m) => m.uid), [1, 2], 'reopening must not renumber')
  assert.equal(again.uidvalidity, opened.uidvalidity)

  setMessageState(first, 'uid@example.com', 'is_archived', true)
  assert.deepEqual(
    openMailbox('uid@example.com', 'inbox').messages.map((m) => m.uid), [2],
    'archiving takes it out of the inbox',
  )

  // Coming back earns a new UID, which is what tells a client it is not the
  // message it cached under the old one.
  setMessageState(first, 'uid@example.com', 'is_archived', false)
  assert.deepEqual(openMailbox('uid@example.com', 'inbox').messages.map((m) => m.uid), [2, 3])
})

test('BODYSTRUCTURE describes a multipart message', () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="xyz"', '', '--xyz',
    'Content-Type: text/plain; charset=utf-8', '', 'hello', '--xyz',
    'Content-Type: text/html; charset=utf-8', '', '<p>hello</p>', '--xyz--', '',
  ].join('\r\n')
  const structure = bodystructure(raw)
  // Size then line count: a text part carries both, and a client that finds
  // only the size reads the next field as the count and loses the rest.
  assert.match(structure, /"TEXT" "PLAIN" \("charset" "utf-8"\) NIL NIL "7bit" 5 1 /, structure)
  assert.match(structure, /"TEXT" "HTML" \("charset" "utf-8"\) NIL NIL "7bit" 12 1 /, structure)
  assert.match(structure, /"ALTERNATIVE" \("boundary" "xyz"\)/i, structure)
})

test('HEADER.FIELDS returns only what was asked for', () => {
  const raw = 'Subject: s\r\nFrom: a@b.c\r\nTo: d@e.f\r\n\r\nbody'
  const only = headerFields(raw, ['subject'])
  assert.match(only, /^Subject: s/)
  assert.doesNotMatch(only, /From:/)
  const except = headerFields(raw, ['subject'], true)
  assert.doesNotMatch(except, /Subject:/)
  assert.match(except, /From: a@b\.c/)
})

test('ENVELOPE quotes what IMAP requires quoting', () => {
  const row = db.prepare(`SELECT * FROM messages WHERE gmail_id = 'g-a'`).get() as never
  const value = envelope(row)
  assert.match(value, /"first"/)
  assert.match(value, /"sender" "example\.org"/)
})

test('AUTHENTICATE PLAIN works without an initial response', async () => {
  // The form clients try first. Refusing it sends them guessing at LOGIN.
  const token = Buffer.from('\0hong@example.com\0hong-password-1').toString('base64')
  const out = await session(['a1 AUTHENTICATE PLAIN', token, 'a2 SELECT INBOX', 'a3 LOGOUT'])
  assert.ok(out.includes('+ '), out.join('\n'))
  assert.ok(out.some((l) => /^a1 OK \[CAPABILITY/.test(l)), out.join('\n'))
  assert.ok(out.some((l) => /^a2 OK \[READ-WRITE\]/.test(l)))
})

test('LIST answers the pattern it was given, not the whole list', async () => {
  const out = await session([
    'a1 LOGIN hong@example.com hong-password-1',
    'a2 LIST "" "Sent"',
    'a3 LIST "" "*"',
    'a4 LOGOUT',
  ])
  const first = out.slice(out.findIndex((l) => /^a1 OK \[CAPABILITY/.test(l)) + 1)
  const untilA2 = first.slice(0, first.findIndex((l) => l.startsWith('a2 ')))
  assert.equal(untilA2.length, 1, untilA2.join('\n'))
  assert.ok(untilA2[0]!.includes('"Sent"'))

  const rest = out.slice(out.findIndex((l) => l.startsWith('a2 OK')) + 1)
  const untilA3 = rest.slice(0, rest.findIndex((l) => l.startsWith('a3 ')))
  assert.equal(untilA3.length, 6, 'a wildcard still lists everything')
})
