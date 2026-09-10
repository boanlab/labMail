import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage, htmlToText } from '../src/google/parse.ts'
import type { gmail_v1 } from 'googleapis'

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url')
const header = (name: string, value: string) => ({ name, value })

const message = (payload: gmail_v1.Schema$MessagePart, extra: Partial<gmail_v1.Schema$Message> = {}) =>
  parseMessage({
    id: 'm1', threadId: 't1', snippet: 'snippet', labelIds: ['INBOX'],
    internalDate: '1700000000000', payload, ...extra,
  })

test('extracts headers, addresses and a plain-text body', () => {
  const parsed = message({
    mimeType: 'text/plain',
    headers: [
      header('From', 'Hong Gildong <hong@example.com>'),
      header('To', 'a@other.org, B <b@other.org>'),
      header('Cc', 'c@other.org'),
      header('Subject', 'Hello'),
      header('Message-ID', '<abc@example.com>'),
      header('Reply-To', 'reply@other.org'),
    ],
    body: { data: b64('Hello there') },
  })

  assert.equal(parsed.fromAddr, 'hong@example.com')
  assert.equal(parsed.fromName, 'Hong Gildong')
  assert.deepEqual(parsed.toAddrs, ['a@other.org', 'b@other.org'])
  assert.deepEqual(parsed.ccAddrs, ['c@other.org'])
  assert.equal(parsed.subject, 'Hello')
  assert.equal(parsed.rfc822Id, '<abc@example.com>')
  assert.equal(parsed.replyTo, 'reply@other.org')
  assert.equal(parsed.bodyText, 'Hello there')
  assert.equal(parsed.internalDate, 1700000000000)
})

test('decodes base64url payloads, including non-ASCII', () => {
  const parsed = message({
    mimeType: 'text/plain', headers: [], body: { data: b64('안녕하세요 ~ ?? >>') },
  })
  assert.equal(parsed.bodyText, '안녕하세요 ~ ?? >>')
})

test('walks multipart/alternative and keeps both representations', () => {
  const parsed = message({
    mimeType: 'multipart/alternative',
    headers: [],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('plain') } },
      { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
    ],
  })
  assert.equal(parsed.bodyText, 'plain')
  assert.equal(parsed.bodyHtml, '<p>html</p>')
})

test('finds a body nested several levels deep', () => {
  const parsed = message({
    mimeType: 'multipart/mixed',
    headers: [],
    parts: [{
      mimeType: 'multipart/related',
      parts: [{
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/plain', body: { data: b64('deep') } }],
      }],
    }],
  })
  assert.equal(parsed.bodyText, 'deep')
})

test('collects attachments and leaves inline parts out of the list', () => {
  const parsed = message({
    mimeType: 'multipart/mixed',
    headers: [],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('body') } },
      {
        mimeType: 'application/pdf', filename: 'report.pdf',
        body: { attachmentId: 'att1', size: 2048 },
      },
      {
        // Inline image: has an attachment id but no filename or disposition.
        mimeType: 'image/png', filename: '',
        headers: [header('Content-Disposition', 'inline')],
        body: { attachmentId: 'att2', size: 100 },
      },
    ],
  })
  assert.equal(parsed.attachments.length, 1)
  assert.deepEqual(parsed.attachments[0], {
    gmailAttachmentId: 'att1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048,
  })
  assert.equal(parsed.bodyText, 'body')
})

test('treats a filename-less part with an attachment disposition as an attachment', () => {
  const parsed = message({
    mimeType: 'multipart/mixed',
    headers: [],
    parts: [{
      mimeType: 'application/octet-stream', filename: '',
      headers: [header('Content-Disposition', 'attachment')],
      body: { attachmentId: 'att3', size: 5 },
    }],
  })
  assert.equal(parsed.attachments.length, 1)
  assert.equal(parsed.attachments[0]!.filename, '(unnamed)')
})

test('lowercases header names and preserves repeats', () => {
  const parsed = message({
    mimeType: 'text/plain',
    headers: [
      header('Delivered-To', 'a@example.com'),
      header('DELIVERED-TO', 'b@example.com'),
      header('X-Gm-Original-To', 'c@example.com'),
    ],
    body: { data: b64('x') },
  })
  assert.deepEqual(parsed.headers['delivered-to'], ['a@example.com', 'b@example.com'])
  assert.deepEqual(parsed.headers['x-gm-original-to'], ['c@example.com'])
})

test('retains only the headers ownership was resolved from', () => {
  const parsed = message({
    mimeType: 'text/plain',
    headers: [
      header('To', 'a@example.com'),
      header('Subject', 'not routing'),
      header('X-Mailer', 'irrelevant'),
    ],
    body: { data: b64('x') },
  })
  assert.deepEqual(Object.keys(parsed.routingHeaders), ['to'])
})

test('survives a message with no payload at all', () => {
  const parsed = parseMessage({ id: 'm2', threadId: 't2', internalDate: '1700000000000' })
  assert.equal(parsed.fromAddr, '')
  assert.equal(parsed.subject, '')
  assert.equal(parsed.bodyText, null)
  assert.equal(parsed.bodyHtml, null)
  assert.deepEqual(parsed.attachments, [])
  assert.deepEqual(parsed.labels, [])
})

test('falls back to the message id when a thread id is absent', () => {
  const parsed = parseMessage({ id: 'solo', internalDate: '1' })
  assert.equal(parsed.gmailThreadId, 'solo')
})

test('derives plain text when the message is HTML only', () => {
  // Without this, body search finds nothing and a reply quotes only the snippet.
  const parsed = message({
    mimeType: 'text/html',
    headers: [],
    body: { data: b64('<p>First paragraph</p><p>Second <b>paragraph</b></p>') },
  })
  assert.equal(parsed.bodyText, 'First paragraph\nSecond paragraph')
  assert.equal(parsed.bodyHtml, '<p>First paragraph</p><p>Second <b>paragraph</b></p>')
})

test('prefers a real text/plain part over the derived one', () => {
  const parsed = message({
    mimeType: 'multipart/alternative',
    headers: [],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('the authored text') } },
      { mimeType: 'text/html', body: { data: b64('<p>the html</p>') } },
    ],
  })
  assert.equal(parsed.bodyText, 'the authored text')
})

test('htmlToText drops scripts, keeps structure and decodes entities', () => {
  assert.equal(
    htmlToText('<style>p{color:red}</style><p>a &amp; b</p><script>evil()</script><p>c</p>'),
    'a & b\nc',
  )
  assert.equal(htmlToText('one<br>two<br/>three'), 'one\ntwo\nthree')
  assert.equal(htmlToText('<ul><li>first</li><li>second</li></ul>'), '• first\n• second')
  assert.equal(htmlToText('&#65;&#x42;&nbsp;C'), 'AB C')
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb')
})
