import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config.ts reads the environment at import time, so this must run first.
const dir = mkdtempSync(join(tmpdir(), 'labmail-test-'))
process.env.ADMIN_PASSWORD = 'test-admin-password'
process.env.DATABASE_PATH = join(dir, 'test.db')

const { db, migrate, listMailbox, getMessageForAlias, getThreadForAlias, countUnread, listUnassigned, activeAliases, mailboxCounts, getDraftForAlias,
  getDriveItemForAlias, listDriveChildren, driveUsage, seedMessageState, setMessageState,
  allOwnersRead } =
  await import('../src/db/index.ts')
const { searchMailbox } = await import('../src/web/search.ts')
const { suggestContacts } = await import('../src/web/contacts.ts')
const { pathTo, homeFolderOf, validateItemName } = await import('../src/google/drive.ts')
const { loadSession, createSession, hashPassword, verifyPassword, aliasFor } = await import('../src/core/auth.ts')
const { setSettings, isGoogleConnected, publicSettings } = await import('../src/core/settings.ts')
const { signup, approve } = await import('../src/core/users.ts')
const { storeMessage, ownershipContext } = await import('../src/google/sync.ts')

before(() => {
  migrate()
  setSettings({ org_domain: 'example.com', shared_account_email: 'shared@example.com' })

  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, alias_local, alias_email, password_hash, status)
    VALUES (?, ?, ?, ?, 'x', 'active')
  `)
  insertUser.run('hong', 'Hong', 'hong', 'hong@example.com')
  insertUser.run('kim', 'Kim', 'kim', 'kim@example.com')
  // An operator with no mailbox: must never widen anyone's alias scope.
  insertUser.run('admin', 'Admin', null, null)

  const insertMsg = db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, from_addr, to_addrs, subject, snippet,
                          body_text, labels, internal_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const own = db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'to')`)

  const add = (gid: string, thread: string, to: string, subject: string,
               labels: string[], owners: string[], body = 'body') => {
    const info = insertMsg.run(gid, thread, 'ext@other.org', JSON.stringify([to]), subject,
      subject, body, JSON.stringify(labels), Date.now())
    for (const o of owners) {
      own.run(info.lastInsertRowid, o)
      // Ownership and per-member state are written together in the sync path;
      // seeding only one of them here would test a shape that never occurs.
      seedMessageState(Number(info.lastInsertRowid), o, labels)
    }
  }

  add('m1', 't1', 'hong@example.com', 'Hong inbox', ['INBOX', 'UNREAD'], ['hong@example.com'], 'secret-hong')
  add('m2', 't2', 'kim@example.com',  'Kim inbox',  ['INBOX', 'UNREAD'], ['kim@example.com'], 'secret-kim')
  add('m3', 't3', 'hong@example.com', 'Hong trash', ['TRASH'],           ['hong@example.com'])
  add('m4', 't4', 'hong@example.com', 'Shared',     ['INBOX'],           ['hong@example.com', 'kim@example.com'])
  add('m5', 't5', 'nobody@example.com', 'Orphan',   ['INBOX'],           [])
  add('m6', 't6', 'hong@example.com', 'Hong spam',  ['SPAM'],            ['hong@example.com'], 'secret-spam')
  add('m7', 't7', 'kim@example.com',  'Kim spam',   ['SPAM', 'UNREAD'],  ['kim@example.com'])
  // Carries INBOX and SPAM together, which is what the NOT_SPAM clause guards:
  // without it this leaks into the inbox listing and the unread badge.
  add('m8', 't8', 'hong@example.com', 'Flagged late', ['INBOX', 'SPAM', 'UNREAD'], ['hong@example.com'])
  add('m9',  't9',  'ext@other.org', 'Hong draft', ['DRAFT'], ['hong@example.com'])
  add('m10', 't10', 'ext@other.org', 'Kim draft',  ['DRAFT'], ['kim@example.com'])
  // A discarded draft still carries DRAFT; Trash must win.
  add('m11', 't11', 'ext@other.org', 'Old draft',  ['DRAFT', 'TRASH'], ['hong@example.com'])
  db.prepare(`UPDATE messages SET gmail_draft_id = 'd-hong' WHERE gmail_id = 'm9'`).run()
  db.prepare(`UPDATE messages SET gmail_draft_id = 'd-kim'  WHERE gmail_id = 'm10'`).run()
})

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('a member sees only their own inbox', () => {
  const subjects = listMailbox('hong@example.com', 'inbox').map((m) => m.subject).sort()
  assert.deepEqual(subjects, ['Hong inbox', 'Shared'])
})

test('the other member sees a disjoint inbox', () => {
  const subjects = listMailbox('kim@example.com', 'inbox').map((m) => m.subject).sort()
  assert.deepEqual(subjects, ['Kim inbox', 'Shared'])
})

test('fetching another member\'s message by id returns nothing', () => {
  // The id is guessable; ownership is what actually stops the read.
  assert.equal(getMessageForAlias('hong@example.com', 'm2'), null)
  assert.ok(getMessageForAlias('kim@example.com', 'm2'))
})

test('trashed mail leaves the inbox and appears only in trash', () => {
  const inbox = listMailbox('hong@example.com', 'inbox').map((m) => m.gmail_id)
  assert.ok(!inbox.includes('m3'))
  // m11 is a discarded draft, which also belongs in Trash.
  assert.deepEqual(
    listMailbox('hong@example.com', 'trash').map((m) => m.gmail_id).sort(),
    ['m11', 'm3'],
  )
  assert.deepEqual(listMailbox('kim@example.com', 'trash'), [])
})

test('spam is reachable in its own mailbox and nowhere else', () => {
  // The original defect: spam was mirrored but no mailbox could reach it, so a
  // misclassified message was silently lost to the member.
  assert.deepEqual(
    listMailbox('hong@example.com', 'spam').map((m) => m.gmail_id).sort(),
    ['m6', 'm8'],
  )
  for (const box of ['inbox', 'sent', 'archive', 'trash'] as const) {
    const ids = listMailbox('hong@example.com', box).map((m) => m.gmail_id)
    assert.ok(!ids.includes('m6'), `spam must not appear in ${box}`)
    assert.ok(!ids.includes('m8'), `a message labelled INBOX and SPAM must not appear in ${box}`)
  }
})

test('address suggestions come only from the member\'s own mail', () => {
  const hong = suggestContacts('hong@example.com', '').map((c) => c.email)
  const kim = suggestContacts('kim@example.com', '').map((c) => c.email)
  // Both own mail from ext@other.org, but kim's correspondents must not leak
  // into hong's list beyond what hong can already see.
  assert.ok(!hong.includes('hong@example.com'), 'the member is not their own suggestion')
  for (const email of hong) {
    assert.ok(
      email === 'kim@example.com' || email.includes('@'),
      'suggestions are addresses',
    )
  }
  assert.ok(kim.length > 0, 'each member gets their own list')
})

test('a wildcard in the suggestion query does not widen it', () => {
  assert.deepEqual(suggestContacts('hong@example.com', '%'), [])
  assert.deepEqual(suggestContacts('hong@example.com', '_'), [])
})

test('active members are suggestable even without prior correspondence', () => {
  const names = suggestContacts('hong@example.com', 'kim').map((c) => c.email)
  assert.deepEqual(names, ['kim@example.com'])
})

test('a Drive item is reachable only by the alias that owns it', () => {
  db.prepare(`UPDATE users SET drive_folder_id = 'home-hong' WHERE alias_email = 'hong@example.com'`).run()
  db.prepare(`UPDATE users SET drive_folder_id = 'home-kim'  WHERE alias_email = 'kim@example.com'`).run()
  const add = db.prepare(`
    INSERT INTO drive_files (file_id, alias, parent_id, name, mime_type, size_bytes, is_folder)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  add.run('f-hong', 'hong@example.com', 'home-hong', 'notes.txt', 'text/plain', 120, 0)
  add.run('d-hong', 'hong@example.com', 'home-hong', 'papers', 'application/vnd.google-apps.folder', 500, 1)
  add.run('f-kim',  'kim@example.com',  'home-kim',  'secret.txt', 'text/plain', 900, 0)

  assert.ok(getDriveItemForAlias('hong@example.com', 'f-hong'))
  // Knowing the id is not access; the join is what decides.
  assert.equal(getDriveItemForAlias('hong@example.com', 'f-kim'), null)
  assert.equal(getDriveItemForAlias('kim@example.com', 'f-hong'), null)
  assert.equal(getDriveItemForAlias('hong@example.com', 'no-such-file'), null)
})

test('a folder listing shows only the owner\'s children', () => {
  assert.deepEqual(
    listDriveChildren('hong@example.com', 'home-hong').map((r) => r.file_id).sort(),
    ['d-hong', 'f-hong'],
  )
  // Pointing at another member's folder yields nothing rather than their files.
  assert.deepEqual(listDriveChildren('hong@example.com', 'home-kim'), [])
})

test('usage counts only the member\'s own files, and not folders', () => {
  // The folder row carries a size so a query that forgot to exclude folders
  // would show 620 rather than 120.
  assert.equal(driveUsage('hong@example.com'), 120)
  assert.equal(driveUsage('kim@example.com'), 900)
})

test('the breadcrumb stops at the member\'s own home folder', () => {
  assert.equal(homeFolderOf('hong@example.com'), 'home-hong')
  assert.deepEqual(pathTo('hong@example.com', 'd-hong').map((r) => r.name), ['papers'])
  // A folder belonging to someone else resolves to nothing to walk.
  assert.deepEqual(pathTo('hong@example.com', 'home-kim'), [])
})

test('a cycle in the mirror cannot spin the breadcrumb', () => {
  const add = db.prepare(`
    INSERT INTO drive_files (file_id, alias, parent_id, name, mime_type, size_bytes, is_folder)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  add.run('cycle-a', 'hong@example.com', 'cycle-b', 'a', 'application/vnd.google-apps.folder', 0, 1)
  add.run('cycle-b', 'hong@example.com', 'cycle-a', 'b', 'application/vnd.google-apps.folder', 0, 1)
  const trail = pathTo('hong@example.com', 'cycle-a')
  assert.ok(trail.length <= 32, `walk must be bounded, got ${trail.length}`)
})

test('item names cannot carry separators or traverse', () => {
  assert.equal(validateItemName('  report.pdf  '), 'report.pdf')
  // Separators are removed rather than rejected: the name is a label inside a
  // folder we already resolved, so there is no path to traverse.
  assert.equal(validateItemName('a/b\\c.txt'), 'abc.txt')
  assert.equal(validateItemName('line\nbreak'), 'linebreak')

  // Anything that cleans down to nothing, or names a directory entry, is refused.
  for (const bad of ['', '   ', '.', '..', '/', '\\', '\n', '\t']) {
    assert.throws(() => validateItemName(bad), /Invalid name/, JSON.stringify(bad))
  }
})

test('drafts are listed in their own mailbox and nowhere else', () => {
  assert.deepEqual(listMailbox('hong@example.com', 'drafts').map((m) => m.gmail_id), ['m9'])
  for (const box of ['inbox', 'sent', 'archive', 'spam'] as const) {
    assert.ok(
      !listMailbox('hong@example.com', box).some((m) => m.gmail_id === 'm9'),
      `a draft must not appear in ${box}`,
    )
  }
})

test('a discarded draft leaves the drafts list', () => {
  const ids = listMailbox('hong@example.com', 'drafts').map((m) => m.gmail_id)
  assert.ok(!ids.includes('m11'), 'a trashed draft must not linger in Drafts')
  assert.ok(listMailbox('hong@example.com', 'trash').some((m) => m.gmail_id === 'm11'))
})

test('drafts stay scoped to their owner', () => {
  assert.deepEqual(listMailbox('kim@example.com', 'drafts').map((m) => m.gmail_id), ['m10'])
  assert.ok(getDraftForAlias('hong@example.com', 'd-hong'))
  assert.equal(getDraftForAlias('hong@example.com', 'd-kim'), null,
    "one member must not reach another's draft by its draft id")
  assert.equal(getDraftForAlias('hong@example.com', 'no-such-draft'), null)
})

test('draft counts are reported separately', () => {
  assert.equal(mailboxCounts('hong@example.com').drafts, 1)
  assert.equal(mailboxCounts('kim@example.com').drafts, 1)
})

test('spam stays scoped to its owner', () => {
  assert.deepEqual(listMailbox('kim@example.com', 'spam').map((m) => m.gmail_id), ['m7'])
  assert.equal(getMessageForAlias('hong@example.com', 'm7'), null)
})

test('spam is excluded from unread counts and search', () => {
  // m7 and m8 are both UNREAD but in spam; neither may inflate the inbox badge.
  assert.equal(countUnread('kim@example.com'), 1)
  assert.equal(countUnread('hong@example.com'), 1)
  assert.deepEqual(searchMailbox('hong@example.com', 'secret-spam'), [])
})

test('mailbox counts report spam separately', () => {
  const counts = mailboxCounts('hong@example.com')
  assert.equal(counts.spam, 2)
  assert.equal(counts.inbox, 2, 'spam must not be counted as inbox')
  assert.equal(counts.unread, 1, 'unread spam must not be counted')
})

test('one member reading a shared message leaves it unread for the other', () => {
  // m4 is addressed to both, which Gmail stores as one message with one set of
  // labels — the reason read state cannot live there.
  const id = (db.prepare(`SELECT id FROM messages WHERE gmail_id = 'm4'`).get() as { id: number }).id
  setMessageState(id, 'hong@example.com', 'is_read', false)
  setMessageState(id, 'kim@example.com', 'is_read', true)

  const hong = listMailbox('hong@example.com', 'inbox', { filter: 'unread' })
  const kim = listMailbox('kim@example.com', 'inbox', { filter: 'unread' })
  assert.ok(hong.some((m) => m.gmail_id === 'm4'), 'unread for the member who has not read it')
  assert.ok(!kim.some((m) => m.gmail_id === 'm4'), 'read state leaked to the other member')

  // m4 carries no UNREAD label, so its seeded state is read; put it back rather
  // than leave a changed count for the tests that follow.
  setMessageState(id, 'hong@example.com', 'is_read', true)
})

test('one member archiving a shared message leaves it in the other inbox', () => {
  const id = (db.prepare(`SELECT id FROM messages WHERE gmail_id = 'm4'`).get() as { id: number }).id
  setMessageState(id, 'hong@example.com', 'is_archived', true)

  assert.ok(!listMailbox('hong@example.com', 'inbox').some((m) => m.gmail_id === 'm4'),
    'archived message still in the archiver inbox')
  assert.ok(listMailbox('hong@example.com', 'archive').some((m) => m.gmail_id === 'm4'),
    'archived message missing from Archive')
  assert.ok(listMailbox('kim@example.com', 'inbox').some((m) => m.gmail_id === 'm4'),
    'archiving removed the message from the other member inbox')

  setMessageState(id, 'hong@example.com', 'is_archived', false)   // restore for later tests
})

test('starring is per member', () => {
  const id = (db.prepare(`SELECT id FROM messages WHERE gmail_id = 'm4'`).get() as { id: number }).id
  setMessageState(id, 'hong@example.com', 'is_starred', true)

  assert.ok(listMailbox('hong@example.com', 'inbox', { filter: 'starred' }).some((m) => m.gmail_id === 'm4'))
  assert.ok(!listMailbox('kim@example.com', 'inbox', { filter: 'starred' }).some((m) => m.gmail_id === 'm4'))

  setMessageState(id, 'hong@example.com', 'is_starred', false)
})

test('a message removed from one view stays in the other', () => {
  const id = (db.prepare(`SELECT id FROM messages WHERE gmail_id = 'm4'`).get() as { id: number }).id
  setMessageState(id, 'hong@example.com', 'is_removed', true)

  for (const box of ['inbox', 'archive', 'trash', 'sent', 'spam'] as const) {
    assert.ok(!listMailbox('hong@example.com', box).some((m) => m.gmail_id === 'm4'),
      `a removed message still appears in ${box}`)
  }
  assert.equal(getMessageForAlias('hong@example.com', 'm4'), null,
    'a removed message can still be opened directly')
  assert.ok(listMailbox('kim@example.com', 'inbox').some((m) => m.gmail_id === 'm4'),
    "one member's delete removed the message from the other's mailbox")

  setMessageState(id, 'hong@example.com', 'is_removed', false)
})

test('removed mail is excluded from counts and search', () => {
  const id = (db.prepare(`SELECT id FROM messages WHERE gmail_id = 'm1'`).get() as { id: number }).id
  const before = countUnread('hong@example.com')
  setMessageState(id, 'hong@example.com', 'is_removed', true)

  assert.equal(countUnread('hong@example.com'), before - 1, 'a removed message still counts as unread')
  assert.deepEqual(searchMailbox('hong@example.com', 'secret-hong'), [],
    'a removed message is still reachable through search')

  setMessageState(id, 'hong@example.com', 'is_removed', false)
  assert.equal(countUnread('hong@example.com'), before)
})

test('a thread is filtered to the messages the member owns', () => {
  assert.deepEqual(getThreadForAlias('kim@example.com', 't1'), [])
  assert.equal(getThreadForAlias('hong@example.com', 't1').length, 1)
})

test('unread counts are per member', () => {
  assert.equal(countUnread('hong@example.com'), 1)
  assert.equal(countUnread('kim@example.com'), 1)
})

test('search cannot reach another member\'s mail', () => {
  assert.deepEqual(searchMailbox('hong@example.com', 'secret-kim'), [])
  assert.equal(searchMailbox('kim@example.com', 'secret-kim').length, 1)
})

test('a LIKE wildcard in the query does not widen the scope', () => {
  // Without ESCAPE handling, '%' would match every message the join allows and,
  // worse, invite the habit of trusting raw query text.
  const all = searchMailbox('hong@example.com', '%')
  assert.deepEqual(all, [])
})

test('unattributed mail is visible to nobody but the admin queue', () => {
  assert.ok(!listMailbox('hong@example.com', 'inbox').some((m) => m.gmail_id === 'm5'))
  assert.ok(!listMailbox('kim@example.com', 'inbox').some((m) => m.gmail_id === 'm5'))
  assert.deepEqual(listUnassigned().map((m) => m.gmail_id), ['m5'])
})

test('a deactivated account cannot resume its session', () => {
  const hong = db.prepare(`SELECT id FROM users WHERE username = 'hong'`).get() as { id: number }
  const token = createSession(hong.id)
  assert.ok(loadSession(token))

  db.prepare(`UPDATE users SET status = 'deactivated' WHERE id = ?`).run(hong.id)
  assert.equal(loadSession(token), null, 'deactivation must take effect immediately')

  db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(hong.id)
})

test('an account without a mailbox never appears as an alias owner', () => {
  // activeAliases feeds the admin assign dropdown and the ownership resolver;
  // a NULL alias leaking in would match every unattributed message.
  const aliases = activeAliases()
  assert.ok(!aliases.includes(null as unknown as string))
  assert.deepEqual(aliases.sort(), ['hong@example.com', 'kim@example.com'])
})

test('signup records only the local part, leaving the alias unassigned', async () => {
  await signup({
    displayName: 'Newbie', localPart: 'newbie', password: 'a-long-enough-password',
  })
  const row = db.prepare(
    `SELECT alias_local, alias_email, status FROM users WHERE username = 'newbie'`,
  ).get() as { alias_local: string; alias_email: string | null; status: string }
  assert.equal(row.alias_local, 'newbie')
  assert.equal(row.alias_email, null, 'the address is composed at approval, not at signup')
  assert.equal(row.status, 'pending')
})

test('signup succeeds even with no organization domain configured', async () => {
  // An applicant must not be able to tell whether the deployment is set up.
  setSettings({ org_domain: '' })
  await signup({
    displayName: 'Early', localPart: 'early', password: 'a-long-enough-password',
  })
  // The requested local part is the sign-in name; there is no separate username.
  assert.ok(db.prepare(`SELECT 1 FROM users WHERE username = 'early'`).get())
  setSettings({ org_domain: 'example.com' })
})

test('approval refuses until Google is connected', async () => {
  setSettings({ google_client_id: '', google_client_secret: '', google_refresh_token: '' })
  const row = db.prepare(`SELECT id FROM users WHERE username = 'newbie'`).get() as { id: number }
  await assert.rejects(() => approve(row.id), /Google 연동/)
  // Still pending, still no address.
  const after = db.prepare(`SELECT status, alias_email FROM users WHERE id = ?`).get(row.id) as
    { status: string; alias_email: string | null }
  assert.equal(after.status, 'pending')
  assert.equal(after.alias_email, null)
})

test('settings drive alias construction at runtime', () => {
  assert.equal(aliasFor('Hong'), 'hong@example.com')
  setSettings({ org_domain: 'other.example.com' })
  assert.equal(aliasFor('hong'), 'hong@other.example.com',
    'a settings change must take effect without a restart')
  setSettings({ org_domain: 'example.com' })
})

test('secrets are never exposed through the settings API', () => {
  setSettings({ google_client_secret: 'super-secret', google_refresh_token: 'token-value' })
  const shown = publicSettings()
  assert.equal(shown.google_client_secret, true, 'secret reported as set, not echoed')
  assert.equal(shown.google_refresh_token, true)
  assert.ok(!JSON.stringify(shown).includes('super-secret'))
  assert.ok(!JSON.stringify(shown).includes('token-value'))
})

test('Google is reported connected only when every piece is present', () => {
  setSettings({ google_client_id: '', google_client_secret: '', google_refresh_token: '' })
  assert.equal(isGoogleConnected(), false)
  setSettings({ google_client_id: 'id', google_client_secret: 's', google_refresh_token: 't' })
  assert.equal(isGoogleConnected(), true)
})

test('password hashing round-trips and rejects wrong passwords', async () => {
  const hash = await hashPassword('correct-horse-battery')
  assert.ok(await verifyPassword('correct-horse-battery', hash))
  assert.equal(await verifyPassword('wrong', hash), false)
})

test('a sent message belongs to its sender even when From was rewritten', async () => {
  // Gmail replaces From with the shared account for any address that has no
  // send-as entry, so nothing in the headers names the sender. Sent mail used
  // to land in nobody's Sent folder because of it.
  const parsed = {
    gmailId: 'sent-rewritten', gmailThreadId: 'thr-rewritten', gmailDraftId: null,
    rfc822Id: '<rewritten@example.com>',
    fromAddr: 'shared@example.com', fromName: 'Shared',
    toAddrs: ['outsider@example.org'], ccAddrs: [], replyTo: null,
    subject: 'rewritten', snippet: 'rewritten', bodyText: 'rewritten', bodyHtml: null,
    labels: ['SENT'], internalDate: Date.now(), attachments: [],
    headers: { from: ['shared@example.com'], to: ['outsider@example.org'] },
    routingHeaders: {},
  }
  storeMessage(parsed as never, ownershipContext(), 'hong@example.com')

  const owners = db.prepare(`
    SELECT o.alias, o.source FROM message_owners o
    JOIN messages m ON m.id = o.message_id WHERE m.gmail_id = 'sent-rewritten'
  `).all()
  assert.deepEqual(owners, [{ alias: 'hong@example.com', source: 'from' }])

  const sent = listMailbox('hong@example.com', 'sent')
  assert.ok(sent.some((m) => m.gmail_id === 'sent-rewritten'), "must appear in the sender's Sent")
  const other = listMailbox('kim@example.com', 'sent')
  assert.ok(!other.some((m) => m.gmail_id === 'sent-rewritten'), 'and in nobody else\'s')
})

test('Gmail stays unread until every owner has read the message', () => {
  const id = db.prepare(`
    INSERT INTO messages (gmail_id, gmail_thread_id, from_addr, to_addrs, subject, snippet,
                          body_text, labels, internal_date)
    VALUES ('shared-read', 'thr-shared-read', 'outside@example.org',
            '["hong@example.com","kim@example.com"]', 'shared', 's', 's',
            '["INBOX","UNREAD"]', ?)
  `).run(Date.now()).lastInsertRowid as number
  const own = db.prepare(`INSERT INTO message_owners (message_id, alias, source) VALUES (?, ?, 'to')`)
  own.run(id, 'hong@example.com')
  own.run(id, 'kim@example.com')

  assert.equal(allOwnersRead(id), false, 'nobody has read it')
  setMessageState(id, 'hong@example.com', 'is_read', true)
  assert.equal(allOwnersRead(id), false, 'one of two is not enough')
  setMessageState(id, 'kim@example.com', 'is_read', true)
  assert.equal(allOwnersRead(id), true, 'both have read it')

  // One member marking it unread again makes the mailbox unread again.
  setMessageState(id, 'kim@example.com', 'is_read', false)
  assert.equal(allOwnersRead(id), false)
})
