import { formatAddress, isValidAddress } from './addresses.ts'

/** RFC 2047 encoded-word, for non-ASCII header values. */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

export interface OutgoingAttachment {
  filename: string
  mimeType: string
  content: Buffer
}

export interface OutgoingMessage {
  fromEmail: string
  fromName?: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  /** Message-ID being replied to, for threading. */
  inReplyTo?: string | null
  references?: string | null
  attachments?: OutgoingAttachment[]
}

function boundary(tag: string): string {
  return `----=_LabMail_${tag}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * Build an RFC 5322 message.
 *
 * Fields originate in a compose form, so header values are sanitized on entry
 * (`formatAddress`, `encodeHeaderValue`) to prevent CRLF header injection.
 */
export class InvalidAddressError extends Error {
  address: string
  constructor(address: string) {
    super(`Invalid email address: ${address}`)
    this.address = address
    this.name = 'InvalidAddressError'
  }
}

/** Reject anything that is not a plain addr-spec before it reaches a header. */
function assertAddresses(...groups: (string[] | undefined)[]): void {
  for (const group of groups) {
    for (const address of group ?? []) {
      if (!isValidAddress(address)) throw new InvalidAddressError(address)
    }
  }
}

/** Message-ID values come from stored headers; keep them header-safe too. */
const headerSafe = (value: string): string =>
  value.replace(/[\r\n\x00-\x1f\x7f]/g, '').trim()

export function buildMime(msg: OutgoingMessage): string {
  assertAddresses([msg.fromEmail], msg.to, msg.cc, msg.bcc)

  const headers: string[] = [
    `From: ${formatAddress(msg.fromEmail, msg.fromName)}`,
    `To: ${msg.to.map((a) => formatAddress(a)).join(', ')}`,
  ]
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.map((a) => formatAddress(a)).join(', ')}`)
  if (msg.bcc?.length) headers.push(`Bcc: ${msg.bcc.map((a) => formatAddress(a)).join(', ')}`)
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`)
  headers.push(`Date: ${new Date().toUTCString()}`)
  headers.push('MIME-Version: 1.0')
  if (msg.inReplyTo) {
    headers.push(`In-Reply-To: ${headerSafe(msg.inReplyTo)}`)
    headers.push(`References: ${headerSafe(msg.references || msg.inReplyTo)}`)
  }

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(msg.bodyText, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n')

  const htmlPart = msg.bodyHtml
    ? [
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(msg.bodyHtml, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      ].join('\r\n')
    : null

  let body: string
  if (htmlPart) {
    const alt = boundary('alt')
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`)
    body = [`--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`, ''].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    headers.push('Content-Transfer-Encoding: base64')
    body = Buffer.from(msg.bodyText, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  }

  if (msg.attachments?.length) {
    const mixed = boundary('mixed')
    // The body becomes the first part of a multipart/mixed; its Content-*
    // headers move inward with it.
    const innerHeaders = headers.filter((h) => h.startsWith('Content-'))
    const outerHeaders = headers.filter((h) => !h.startsWith('Content-'))
    outerHeaders.push(`Content-Type: multipart/mixed; boundary="${mixed}"`)

    const parts = [`--${mixed}`, [...innerHeaders, '', body].join('\r\n')]
    for (const att of msg.attachments) {
      parts.push(
        `--${mixed}`,
        [
          `Content-Type: ${att.mimeType}; name="${encodeHeaderValue(att.filename)}"`,
          `Content-Disposition: attachment; filename="${encodeHeaderValue(att.filename)}"`,
          'Content-Transfer-Encoding: base64',
          '',
          att.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
        ].join('\r\n'),
      )
    }
    parts.push(`--${mixed}--`, '')
    return [...outerHeaders, '', parts.join('\r\n')].join('\r\n')
  }

  return [...headers, '', body].join('\r\n')
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url')
}
