import { canonicalize, formatAddress, parseAddressList } from '../google/addresses.ts'

/** Headers a client must not decide for itself. */
const STRIPPED = new Set(['from', 'sender', 'return-path', 'bcc'])

/** Split a message into its header block and everything after it. */
function split(raw: string): { headers: string; body: string } {
  const at = raw.indexOf('\r\n\r\n')
  if (at < 0) return { headers: raw.replace(/\r\n$/, ''), body: '' }
  return { headers: raw.slice(0, at), body: raw.slice(at + 4) }
}

/** Header lines, with folded continuations kept attached to their field. */
function unfold(headers: string): string[] {
  const out: string[] = []
  for (const line of headers.split('\r\n')) {
    if (/^[ \t]/.test(line) && out.length > 0) out[out.length - 1] += '\r\n' + line
    else out.push(line)
  }
  return out.filter((l) => l.length > 0)
}

const nameOf = (line: string): string => line.slice(0, line.indexOf(':')).trim().toLowerCase()

function addressesIn(lines: string[], field: string): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (nameOf(line) !== field) continue
    for (const addr of parseAddressList(line.slice(line.indexOf(':') + 1))) out.push(addr.email)
  }
  return out
}

export interface RewriteResult {
  raw: string
  /** Envelope recipients that no visible header named. */
  bcc: string[]
}

/**
 * Put the submitted message under the sender labMail authenticated.
 *
 * The client's `From` is discarded rather than checked: trusting it lets any
 * member send as any other.
 *
 * `Bcc` is rebuilt from the envelope. SMTP carries blind recipients in
 * `RCPT TO` alone, and delivery follows the headers once the message reaches
 * Gmail, so an envelope recipient no header names would be dropped.
 */
export function rewriteSubmission(
  raw: string, sender: { alias: string; displayName: string }, envelope: string[],
): RewriteResult {
  const { headers, body } = split(raw)
  const lines = unfold(headers).filter((line) => !STRIPPED.has(nameOf(line)))

  const visible = new Set(
    [...addressesIn(lines, 'to'), ...addressesIn(lines, 'cc')].map((a) => canonicalize(a)),
  )
  const bcc: string[] = []
  for (const address of envelope) {
    const key = canonicalize(address)
    if (visible.has(key) || bcc.some((b) => canonicalize(b) === key)) continue
    bcc.push(address)
  }

  const rebuilt = [`From: ${formatAddress(sender.alias, sender.displayName)}`, ...lines]
  if (bcc.length > 0) rebuilt.push(`Bcc: ${bcc.map((b) => formatAddress(b)).join(', ')}`)

  return { raw: `${rebuilt.join('\r\n')}\r\n\r\n${body}`, bcc }
}
