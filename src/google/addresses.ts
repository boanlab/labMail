/** RFC 5322 address-list parsing. */

export interface ParsedAddress {
  /** Lowercased addr-spec, e.g. `hong@example.com`. */
  email: string
  /** Display name if the header carried one. */
  name?: string
}

/** Split on commas outside quotes and angle brackets. */
function splitAddressList(raw: string): string[] {
  const parts: string[] = []
  let buf = ''
  let inQuotes = false
  let depth = 0

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '\\' && inQuotes) {
      buf += ch + (raw[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') { inQuotes = !inQuotes; buf += ch; continue }
    if (!inQuotes && ch === '<') depth++
    if (!inQuotes && ch === '>') depth = Math.max(0, depth - 1)
    if (ch === ',' && !inQuotes && depth === 0) { parts.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) parts.push(buf)
  return parts
}

export function parseAddressList(raw: string | undefined | null): ParsedAddress[] {
  if (!raw) return []
  const out: ParsedAddress[] = []

  for (const part of splitAddressList(raw)) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const angled = trimmed.match(/<([^>]*)>/)
    if (angled) {
      const email = angled[1]!.trim().toLowerCase()
      if (!email.includes('@')) continue
      const name = trimmed.slice(0, angled.index).trim().replace(/^"|"$/g, '').trim()
      out.push(name ? { email, name } : { email })
      continue
    }

    // Bare addr-spec, possibly with a trailing comment.
    const bare = trimmed.replace(/\(.*?\)/g, '').trim().toLowerCase()
    if (bare.includes('@') && !/\s/.test(bare)) out.push({ email: bare })
  }
  return out
}

/** First address in a header, or null. */
export function parseSingleAddress(raw: string | undefined | null): ParsedAddress | null {
  return parseAddressList(raw)[0] ?? null
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

export function localPartOf(email: string): string {
  return email.slice(0, email.lastIndexOf('@')).toLowerCase()
}

/**
 * Canonical form for alias matching. Plus-tags stripped, dots preserved:
 * dot-folding is a gmail.com equivalence, not a custom-domain one.
 */
export function canonicalize(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0) return email.trim().toLowerCase()
  const local = email.slice(0, at).toLowerCase()
  const domain = email.slice(at + 1).toLowerCase()
  const plus = local.indexOf('+')
  return `${plus >= 0 ? local.slice(0, plus) : local}@${domain}`
}

/**
 * Shape an address must have before it may enter a header. Rejected rather than
 * sanitized: a silently cleaned address still sends, to the wrong place.
 */
const ADDR_SPEC = /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/

export function isValidAddress(email: string): boolean {
  return ADDR_SPEC.test(email.trim())
}

/**
 * Render an address for a From/To header, quoting the name when needed. Both
 * parts are stripped of CR/LF: a newline here injects arbitrary headers.
 */
export function formatAddress(email: string, name?: string): string {
  const address = email.replace(/[\r\n\x00-\x1f\x7f]/g, '').trim()
  if (!name) return address
  const clean = name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim()
  if (!clean) return address
  const needsQuoting = /[",:;<>@\[\]\\]/.test(clean)
  const escaped = clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `${needsQuoting || /[^\x20-\x7e]/.test(clean) ? `"${escaped}"` : clean} <${address}>`
}
