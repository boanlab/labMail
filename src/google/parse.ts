import type { gmail_v1 } from 'googleapis'
import type { Headers } from './ownership.ts'
import { parseAddressList, parseSingleAddress } from './addresses.ts'

export interface AttachmentMeta {
  gmailAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface ParsedMessage {
  gmailId: string
  gmailThreadId: string
  rfc822Id: string | null
  fromAddr: string
  fromName: string | null
  toAddrs: string[]
  ccAddrs: string[]
  replyTo: string | null
  subject: string
  snippet: string
  bodyText: string | null
  bodyHtml: string | null
  labels: string[]
  internalDate: number
  headers: Headers
  attachments: AttachmentMeta[]
  /** Headers ownership was resolved from, for auditing a misroute. */
  routingHeaders: Record<string, string[]>
}

// `authentication-results` is not used for routing; it is kept so the
// deployment can be told whether DKIM and DMARC actually pass, which is
// otherwise only visible by reading raw source in Gmail.
const ROUTING_HEADER_NAMES = [
  'x-gm-original-to', 'x-beenthere', 'delivered-to', 'to', 'cc', 'from',
  // A Group rewrites From to itself, leaving the real sender only here.
  'x-original-sender',
  'authentication-results',
]

function collectHeaders(payload: gmail_v1.Schema$MessagePart | undefined): Headers {
  const out: Headers = {}
  for (const h of payload?.headers ?? []) {
    if (!h.name) continue
    const key = h.name.toLowerCase()
    ;(out[key] ??= []).push(h.value ?? '')
  }
  return out
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return ''
  // Gmail returns base64url without padding.
  return Buffer.from(data, 'base64url').toString('utf8')
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–',
  mdash: '—', hellip: '…', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
}

/**
 * Plain-text rendering of an HTML body.
 *
 * Messages sent as HTML only carry no text/plain part, which would otherwise
 * leave `bodyText` null — making the body unsearchable and reducing a reply's
 * quoted history to the snippet.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\u2022 ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(\w+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Walked {
  text: string | null
  html: string | null
  attachments: AttachmentMeta[]
}

/**
 * Depth-first walk of the MIME tree.
 *
 * Attachment = a part with a filename or an attachment disposition; inline
 * images without either are excluded from the list.
 */
function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: Walked): Walked {
  if (!part) return acc

  const mime = part.mimeType ?? ''
  const filename = part.filename ?? ''
  const disposition = (part.headers ?? [])
    .find((h) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''

  const isAttachment =
    Boolean(part.body?.attachmentId) &&
    (filename !== '' || /attachment/i.test(disposition))

  if (isAttachment) {
    acc.attachments.push({
      gmailAttachmentId: part.body!.attachmentId!,
      filename: filename || '(unnamed)',
      mimeType: mime || 'application/octet-stream',
      sizeBytes: part.body?.size ?? 0,
    })
  } else if (mime === 'text/plain' && acc.text === null) {
    acc.text = decodeBody(part.body?.data)
  } else if (mime === 'text/html' && acc.html === null) {
    acc.html = decodeBody(part.body?.data)
  }

  for (const child of part.parts ?? []) walkParts(child, acc)
  return acc
}

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const headers = collectHeaders(msg.payload)
  const first = (name: string): string | undefined => headers[name]?.[0]

  const body = walkParts(msg.payload, { text: null, html: null, attachments: [] })
  const from = parseSingleAddress(first('from'))

  const routingHeaders: Record<string, string[]> = {}
  for (const name of ROUTING_HEADER_NAMES) {
    if (headers[name]) routingHeaders[name] = headers[name]!
  }

  // Derived when the message carries no text/plain part, so search and reply
  // quoting have something to work with.
  const bodyText = body.text ?? (body.html ? htmlToText(body.html) : null)

  return {
    gmailId: msg.id!,
    gmailThreadId: msg.threadId ?? msg.id!,
    rfc822Id: first('message-id') ?? null,
    fromAddr: from?.email ?? '',
    fromName: from?.name ?? null,
    toAddrs: parseAddressList(first('to')).map((a) => a.email),
    ccAddrs: parseAddressList(first('cc')).map((a) => a.email),
    replyTo: parseSingleAddress(first('reply-to'))?.email ?? null,
    subject: first('subject') ?? '',
    snippet: msg.snippet ?? '',
    bodyText,
    bodyHtml: body.html,
    labels: msg.labelIds ?? [],
    internalDate: Number(msg.internalDate ?? Date.now()),
    headers,
    attachments: body.attachments,
    routingHeaders,
  }
}
