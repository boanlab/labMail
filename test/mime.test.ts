import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMime, encodeHeaderValue, toBase64Url, InvalidAddressError } from '../src/google/mime.ts'
import { isValidAddress } from '../src/google/addresses.ts'

const base = {
  fromEmail: 'hong@example.com',
  to: ['ext@other.org'],
  subject: 'Hello',
  bodyText: 'Body text',
}

/** Header block, i.e. everything before the first blank line. */
const headers = (raw: string): string => raw.split('\r\n\r\n')[0]!
const headerLine = (raw: string, name: string): string | undefined =>
  headers(raw).split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))

test('builds a minimal message with CRLF line endings', () => {
  const raw = buildMime(base)
  assert.match(raw, /^From: hong@example\.com\r\n/)
  assert.equal(headerLine(raw, 'To'), 'To: ext@other.org')
  assert.equal(headerLine(raw, 'Subject'), 'Subject: Hello')
  assert.ok(headers(raw).includes('MIME-Version: 1.0'))
  assert.ok(!raw.includes('\n\n'), 'must not emit bare LF separators')
})

test('encodes a non-ASCII subject as an RFC 2047 word', () => {
  const raw = buildMime({ ...base, subject: '안녕하세요' })
  const line = headerLine(raw, 'Subject')!
  assert.match(line, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
  const encoded = line.match(/\?B\?([^?]+)\?=/)![1]!
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), '안녕하세요')
})

test('leaves a plain ASCII subject unencoded', () => {
  assert.equal(encodeHeaderValue('Simple subject'), 'Simple subject')
})

test('a display name cannot inject headers', () => {
  // The name reaches here straight from a compose form.
  const raw = buildMime({ ...base, fromName: 'Hong\r\nBcc: attacker@evil.net' })
  assert.ok(!/^Bcc:/mi.test(raw), 'injected Bcc header must not appear')
  assert.equal(headers(raw).split('\r\n').filter((l) => l.startsWith('From:')).length, 1)
})

test('a subject cannot inject headers', () => {
  const raw = buildMime({ ...base, subject: 'Hi\r\nX-Injected: yes' })
  assert.ok(!/^X-Injected:/mi.test(raw))
})

test('a recipient carrying CRLF is rejected outright', () => {
  // A silently stripped address would still send, just somewhere unintended,
  // so the send fails instead.
  assert.throws(
    () => buildMime({ ...base, to: ['ok@other.org\r\nBcc: attacker@evil.net'] }),
    InvalidAddressError,
  )
  for (const field of ['cc', 'bcc'] as const) {
    assert.throws(
      () => buildMime({ ...base, [field]: ['ok@other.org\r\nBcc: attacker@evil.net'] }),
      InvalidAddressError,
      `${field} must be validated too`,
    )
  }
  assert.throws(
    () => buildMime({ ...base, fromEmail: 'me@example.com\r\nBcc: attacker@evil.net' }),
    InvalidAddressError,
  )
})

test('address validation accepts ordinary addresses and rejects malformed ones', () => {
  for (const ok of ['a@b.co', 'hong.gd+tag@sub.example.com', "o'brien@example.com"]) {
    assert.ok(isValidAddress(ok), `${ok} should be accepted`)
  }
  for (const bad of ['no-at-sign', 'a@b', 'a b@c.com', 'a@b.com\r\nX: y', '<a@b.com>', '', 'a@@b.com']) {
    assert.equal(isValidAddress(bad), false, `${JSON.stringify(bad)} should be rejected`)
  }
})

test('a stored Message-ID cannot inject headers when replying', () => {
  const raw = buildMime({ ...base, inReplyTo: '<a@b.com>\r\nBcc: attacker@evil.net' })
  assert.ok(!/^Bcc:/mi.test(raw))
})

test('carries reply threading headers', () => {
  const raw = buildMime({ ...base, inReplyTo: '<abc@example.com>' })
  assert.equal(headerLine(raw, 'In-Reply-To'), 'In-Reply-To: <abc@example.com>')
  assert.equal(headerLine(raw, 'References'), 'References: <abc@example.com>')
})

test('prefers an explicit References chain over the single id', () => {
  const raw = buildMime({
    ...base, inReplyTo: '<b@example.com>', references: '<a@example.com> <b@example.com>',
  })
  assert.equal(headerLine(raw, 'References'), 'References: <a@example.com> <b@example.com>')
})

test('omits threading headers when not replying', () => {
  const raw = buildMime(base)
  assert.equal(headerLine(raw, 'In-Reply-To'), undefined)
  assert.equal(headerLine(raw, 'References'), undefined)
})

test('emits Cc and Bcc only when present', () => {
  const bare = buildMime(base)
  assert.equal(headerLine(bare, 'Cc'), undefined)
  assert.equal(headerLine(bare, 'Bcc'), undefined)

  const full = buildMime({ ...base, cc: ['c@other.org'], bcc: ['b@other.org'] })
  assert.equal(headerLine(full, 'Cc'), 'Cc: c@other.org')
  assert.equal(headerLine(full, 'Bcc'), 'Bcc: b@other.org')
})

test('quotes a display name containing special characters', () => {
  const raw = buildMime({ ...base, fromName: 'Hong, Gildong' })
  assert.equal(headerLine(raw, 'From'), 'From: "Hong, Gildong" <hong@example.com>')
})

test('an HTML body produces multipart/alternative carrying both parts', () => {
  const raw = buildMime({ ...base, bodyHtml: '<p>Body <b>html</b></p>' })
  const contentType = headerLine(raw, 'Content-Type')!
  assert.match(contentType, /^Content-Type: multipart\/alternative; boundary="[^"]+"$/)

  const boundary = contentType.match(/boundary="([^"]+)"/)![1]!
  const parts = raw.split(`--${boundary}`)
  assert.equal(parts.length, 4, 'two parts plus preamble and closing marker')
  assert.ok(parts[1]!.includes('text/plain'))
  assert.ok(parts[2]!.includes('text/html'))
  assert.ok(raw.trimEnd().endsWith(`--${boundary}--`))

  const decode = (part: string) =>
    Buffer.from(part.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8')
  assert.equal(decode(parts[1]!), 'Body text')
  assert.equal(decode(parts[2]!), '<p>Body <b>html</b></p>')
})

test('attachments produce multipart/mixed wrapping the body', () => {
  const raw = buildMime({
    ...base,
    attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFDATA') }],
  })
  const contentType = headerLine(raw, 'Content-Type')!
  assert.match(contentType, /^Content-Type: multipart\/mixed; boundary="[^"]+"$/)

  const boundary = contentType.match(/boundary="([^"]+)"/)![1]!
  const parts = raw.split(`--${boundary}`)
  assert.equal(parts.length, 4)
  assert.ok(parts[2]!.includes('Content-Disposition: attachment; filename="report.pdf"'))
  assert.ok(parts[2]!.includes('application/pdf'))

  const payload = parts[2]!.split('\r\n\r\n')[1]!.replace(/\r\n/g, '')
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), 'PDFDATA')
})

test('attachments coexist with an HTML body', () => {
  const raw = buildMime({
    ...base,
    bodyHtml: '<p>hi</p>',
    attachments: [{ filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('x') }],
  })
  const mixed = headerLine(raw, 'Content-Type')!.match(/boundary="([^"]+)"/)![1]!
  const first = raw.split(`--${mixed}`)[1]!
  assert.ok(first.includes('multipart/alternative'), 'the body keeps its own structure inside')
  assert.ok(first.includes('text/plain') && first.includes('text/html'))
  // The alternative boundary must differ from the mixed one, or parsers break.
  const alt = first.match(/boundary="([^"]+)"/)![1]!
  assert.notEqual(alt, mixed)
})

test('a non-ASCII attachment filename is encoded', () => {
  const raw = buildMime({
    ...base,
    attachments: [{ filename: '보고서.pdf', mimeType: 'application/pdf', content: Buffer.from('x') }],
  })
  assert.ok(!raw.includes('보고서.pdf'), 'raw UTF-8 must not appear in a header')
  assert.match(raw, /filename="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="/)
})

test('base64 payload lines stay within the 76-character limit', () => {
  const raw = buildMime({ ...base, bodyText: 'x'.repeat(5000) })
  const payload = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
  for (const line of payload.split('\r\n')) {
    assert.ok(line.length <= 76, `line of ${line.length} chars exceeds the limit`)
  }
})

test('a non-ASCII body round-trips through base64', () => {
  const raw = buildMime({ ...base, bodyText: '안녕하세요\n반갑습니다' })
  const payload = raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, '')
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), '안녕하세요\n반갑습니다')
})

test('toBase64Url produces the URL-safe alphabet Gmail expects', () => {
  const encoded = toBase64Url('a+b/c?d=e')
  assert.ok(!encoded.includes('+') && !encoded.includes('/') && !encoded.includes('='))
  assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), 'a+b/c?d=e')
})
