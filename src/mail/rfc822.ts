import { gmail } from '../google/client.ts'
import { parseAddressList, type ParsedAddress } from '../google/addresses.ts'
import type { MessageRow } from '../db/index.ts'

/**
 * Original bytes of a message, fetched on demand.
 *
 * The mirror stores parsed bodies, not the source. IMAP hands out the source:
 * `BODY[]` must be byte-exact and `BODYSTRUCTURE` must describe those exact
 * bytes, and a message rebuilt from parsed parts is neither -- it would also
 * break any signature the sender applied.
 *
 * Cached in memory rather than stored, so the mirror does not double in size
 * for a copy the client keeps anyway.
 */
const CACHE_LIMIT_BYTES = 64 * 1024 * 1024
const cache = new Map<string, string>()
let cacheBytes = 0

export function cachedRaw(gmailId: string): string | undefined {
  const hit = cache.get(gmailId)
  if (hit === undefined) return undefined
  cache.delete(gmailId)                       // re-insert to keep it warm
  cache.set(gmailId, hit)
  return hit
}

export async function fetchRaw(gmailId: string): Promise<string> {
  const hit = cachedRaw(gmailId)
  if (hit !== undefined) return hit

  const res = await gmail().users.messages.get({ userId: 'me', id: gmailId, format: 'raw' })
  const raw = Buffer.from(res.data.raw ?? '', 'base64url').toString('binary')

  cache.set(gmailId, raw)
  cacheBytes += raw.length
  while (cacheBytes > CACHE_LIMIT_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string
    cacheBytes -= cache.get(oldest)!.length
    cache.delete(oldest)
  }
  return raw
}

// ── Literals ───────────────────────────────────────────────────────────────

/** NIL, or a quoted string with the two characters IMAP requires escaped. */
export function quoted(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'NIL'
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const list = (items: string[]): string => (items.length === 0 ? 'NIL' : `(${items.join(' ')})`)

// ── Header access ──────────────────────────────────────────────────────────

export function headerBlock(raw: string): string {
  const at = raw.indexOf('\r\n\r\n')
  return at < 0 ? raw : raw.slice(0, at + 2)
}

export function bodyBlock(raw: string): string {
  const at = raw.indexOf('\r\n\r\n')
  return at < 0 ? '' : raw.slice(at + 4)
}

/** Unfolded header lines, in order. */
function headerLines(raw: string): string[] {
  const out: string[] = []
  for (const line of headerBlock(raw).split('\r\n')) {
    if (line === '') continue
    if (/^[ \t]/.test(line) && out.length > 0) out[out.length - 1] += ' ' + line.trim()
    else out.push(line)
  }
  return out
}

export function headerValue(raw: string, name: string): string | null {
  const want = name.toLowerCase()
  for (const line of headerLines(raw)) {
    const colon = line.indexOf(':')
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === want) {
      return line.slice(colon + 1).trim()
    }
  }
  return null
}

/** The subset of headers a client asked for, in RFC 822 form. */
export function headerFields(raw: string, names: string[], exclude = false): string {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const out: string[] = []
  let keeping = false
  for (const line of headerBlock(raw).split('\r\n')) {
    if (/^[ \t]/.test(line)) { if (keeping) out.push(line); continue }
    const colon = line.indexOf(':')
    const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : ''
    keeping = name !== '' && (exclude ? !wanted.has(name) : wanted.has(name))
    if (keeping) out.push(line)
  }
  return out.length === 0 ? '\r\n' : out.join('\r\n') + '\r\n\r\n'
}

// ── ENVELOPE ───────────────────────────────────────────────────────────────

const addressItems = (addresses: ParsedAddress[]): string =>
  list(addresses.map((a) => {
    const at = a.email.indexOf('@')
    const local = at < 0 ? a.email : a.email.slice(0, at)
    const host = at < 0 ? null : a.email.slice(at + 1)
    return `(${quoted(a.name ?? null)} NIL ${quoted(local)} ${quoted(host)})`
  }))

/**
 * ENVELOPE, built from the mirror rather than the source.
 *
 * The list view is the one place a client asks about every message at once, so
 * answering it without reaching for the original keeps opening a mailbox from
 * costing one Gmail request per message.
 */
export function envelope(row: MessageRow): string {
  const from = addressItems([{ email: row.from_addr, name: row.from_name ?? undefined }])
  const to = addressItems(
    (JSON.parse(row.to_addrs) as string[]).map((email) => ({ email })),
  )
  const cc = addressItems(
    (JSON.parse(row.cc_addrs) as string[]).map((email) => ({ email })),
  )
  const date = new Date(row.internal_date).toUTCString().replace('GMT', '+0000')
  return [
    quoted(date), quoted(row.subject), from, from, from, to, cc, 'NIL', 'NIL',
    quoted(row.rfc822_id),
  ].join(' ')
}

// ── BODYSTRUCTURE ──────────────────────────────────────────────────────────

interface Part {
  headers: string
  body: string
  children: Part[]
}

function parameters(value: string): { base: string; params: [string, string][] } {
  const [head, ...rest] = value.split(';')
  const params: [string, string][] = []
  for (const item of rest) {
    const eq = item.indexOf('=')
    if (eq < 0) continue
    const key = item.slice(0, eq).trim()
    let val = item.slice(eq + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    params.push([key, val])
  }
  return { base: (head ?? '').trim(), params }
}

function partOf(raw: string): Part {
  const headers = headerBlock(raw)
  const body = bodyBlock(raw)
  const type = headerValue(raw, 'content-type') ?? 'text/plain'
  const { base, params } = parameters(type)
  const boundary = params.find(([k]) => k.toLowerCase() === 'boundary')?.[1]

  if (!base.toLowerCase().startsWith('multipart/') || !boundary) {
    return { headers, body, children: [] }
  }

  const children: Part[] = []
  const marker = `--${boundary}`
  const segments = body.split(new RegExp(`(?:^|\\r\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?(?:\\r\\n|$)`))
  for (const segment of segments.slice(1, -1)) {
    if (segment.trim() !== '') children.push(partOf(segment))
  }
  return { headers, body, children }
}

function structureOf(part: Part): string {
  const raw = part.headers
  const type = headerValue(raw, 'content-type') ?? 'text/plain; charset=us-ascii'
  const { base, params } = parameters(type)
  const [major = 'TEXT', minor = 'PLAIN'] = base.toUpperCase().split('/')
  const encoding = headerValue(raw, 'content-transfer-encoding') ?? '7bit'
  const id = headerValue(raw, 'content-id')
  const description = headerValue(raw, 'content-description')
  const disposition = headerValue(raw, 'content-disposition')

  if (part.children.length > 0) {
    const inner = part.children.map(structureOf).join('')
    const attrs = list(params.flatMap(([k, v]) => [quoted(k), quoted(v)]))
    return `(${inner} ${quoted(minor)} ${attrs} NIL NIL NIL)`
  }

  const attrs = list(params.flatMap(([k, v]) => [quoted(k), quoted(v)]))
  const size = part.body.length
  const base5 = `${quoted(major)} ${quoted(minor)} ${attrs} ${quoted(id)} ${quoted(description)} ${quoted(encoding)} ${size}`
  const lines = major === 'TEXT' ? ` ${part.body.split('\r\n').length}` : ''
  const dispositionItem = disposition
    ? (() => {
        const d = parameters(disposition)
        return `(${quoted(d.base)} ${list(d.params.flatMap(([k, v]) => [quoted(k), quoted(v)]))})`
      })()
    : 'NIL'
  return `(${base5}${lines} NIL ${dispositionItem} NIL NIL)`
}

/** IMAP BODYSTRUCTURE for the original bytes. */
export function bodystructure(raw: string): string {
  return structureOf(partOf(raw))
}
