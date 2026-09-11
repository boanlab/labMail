import { createServer, type Server, type Socket } from 'node:net'
import { db, messageStateFor, type Mailbox } from '../db/index.ts'
import { applyAction } from '../google/actions.ts'
import { subscribe } from '../core/events.ts'
import { heldMessageIds } from '../google/outbox.ts'
import { audit } from '../core/audit.ts'
import { guard, recordFailure, recordSuccess } from '../core/throttle.ts'
import { verifyMailCredential, type MailIdentity } from './credentials.ts'
import { IMAP_MAILBOXES, mailboxByName, openMailbox, type UidMessage } from './uid.ts'
import {
  bodyBlock, bodystructure, envelope, fetchRaw, headerBlock, headerFields, quoted,
} from './rfc822.ts'

/**
 * IMAP over the same per-member view the web client reads.
 *
 * Writes go through `applyAction`, the function the web interface calls, so a
 * flag set from a mail client behaves as it does from a browser.
 */
const CAPABILITIES = 'IMAP4rev1 AUTH=PLAIN SPECIAL-USE IDLE UIDPLUS MOVE'
const MAX_LINE_BYTES = 8_192
const MAX_AUTH_FAILURES = 3
const IDLE_MS = 30 * 60_000

interface Selected {
  name: string
  mailbox: Mailbox
  uidvalidity: number
  uidnext: number
  messages: UidMessage[]
}

interface Session {
  socket: Socket
  ip: string
  identity: MailIdentity | null
  selected: Selected | null
  authFailures: number
  /** Set while the server has invited a continuation line. */
  pendingContinuation: ((line: string) => void) | null
  /** Set while the server is collecting an APPEND literal. */
  pendingLiteral: { want: number; seen: string; resolve: (body: string) => void } | null
  /** Messages this session has flagged \Deleted, by UID. */
  deleted: Set<number>
  /** Unsubscribes the IDLE listener; set only while idling. */
  idle: (() => void) | null
}

const send = (s: Session, line: string): void => {
  trace('out', 'imap', line)
  s.socket.write(line + '\r\n')
}

/**
 * Protocol trace, off unless asked for. A client reporting a sign-in failure
 * may have signed in and failed on the command after it; only the exchange
 * itself tells them apart. Credentials are redacted.
 */
const TRACE = process.env.MAIL_TRACE === 'true'

/** Anything after the command word is the secret. Tags are the client's own. */
const REDACT: [RegExp, string][] = [
  [/^(\S+\s+LOGIN\s+\S+)\s+.*$/i, '$1 <redacted>'],
  [/^(\S+\s+(?:AUTHENTICATE|LOGIN)\b).*$/i, '$1 <redacted>'],
  [/^(AUTH\b).*$/i, '$1 <redacted>'],
]

function trace(direction: string, protocol: string, text: string): void {
  if (!TRACE) return
  let shown = text
  for (const [pattern, replacement] of REDACT) {
    if (pattern.test(shown)) { shown = shown.replace(pattern, replacement); break }
  }
  console.log(`[${protocol} ${direction}] ${shown.slice(0, 500)}`)
}

/**
 * A connection dropped for want of a PROXY header, said out loud: silence is
 * indistinguishable from a firewall. Rate-limited against scanners.
 */
let lastProxyComplaint = 0
function refuseProxy(socket: Socket, protocol: string): void {
  const now = Date.now()
  if (now - lastProxyComplaint > 60_000) {
    lastProxyComplaint = now
    console.error(
      `[${protocol}] connection from ${socket.remoteAddress} closed: expected a PROXY ` +
      `protocol header. Set "proxy_protocol on" on the proxy, or unset ` +
      `${protocol.toUpperCase()}_PROXY_PROTOCOL.`,
    )
  }
  socket.destroy()
}

function flagsOf(s: Session, entry: UidMessage): string {
  const state = messageStateFor(entry.row.id, s.identity!.alias)
  const flags: string[] = []
  if (state.read) flags.push('\\Seen')
  if (state.starred) flags.push('\\Flagged')
  if ((JSON.parse(entry.row.labels) as string[]).includes('DRAFT')) flags.push('\\Draft')
  // Held on the session until EXPUNGE, and readable back meanwhile.
  if (s.deleted.has(entry.uid)) flags.push('\\Deleted')
  return flags.join(' ')
}

/** Flag names to the verbs the web interface uses for the same changes. */
const FLAG_ACTIONS: Record<string, { on: string; off: string }> = {
  '\\SEEN': { on: 'read', off: 'unread' },
  '\\FLAGGED': { on: 'star', off: 'unstar' },
}

/** Where a COPY or MOVE lands, in terms of this member's own state. */
const MOVE_ACTIONS: Record<string, string | null> = {
  inbox: 'unarchive',
  archive: 'archive',
  trash: 'trash',
  spam: 'spam',
  sent: null,
  drafts: null,
}

/** `1:*`, `3`, `2:4,7` — resolved against UIDs or sequence numbers. */
function inRange(spec: string, value: number, highest: number): boolean {
  for (const part of spec.split(',')) {
    const [lo, hi] = part.split(':')
    const low = lo === '*' ? highest : Number(lo)
    if (hi === undefined) { if (value === low) return true; continue }
    const high = hi === '*' ? highest : Number(hi)
    if (value >= Math.min(low, high) && value <= Math.max(low, high)) return true
  }
  return false
}

/**
 * An IMAP mailbox pattern: `*` spans the hierarchy, `%` stops at a delimiter.
 * Answering every probe with the whole list tells a client nothing.
 */
function matchesPattern(pattern: string, name: string): boolean {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '\u0000')
    .replace(/%/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${expression}$`, 'i').test(name)
}

/** The entry as it stands now, after a state change. */
function refresh(s: Session, entry: UidMessage): UidMessage {
  const fresh = s.selected?.messages.find((m) => m.uid === entry.uid)
  return fresh ?? entry
}

/** Re-read the mailbox after something moved out of it. */
function reselect(s: Session): void {
  if (!s.selected || !s.identity) return
  const view = openMailbox(s.identity.alias, s.selected.mailbox)
  s.selected = { name: s.selected.name, mailbox: s.selected.mailbox, ...view }
}

/**
 * Remove what this session flagged \Deleted: the per-member removal the web
 * Trash performs, leaving the message where it is for everyone else.
 */
async function expunge(s: Session, uidSpec: string | null): Promise<void> {
  if (!s.selected || !s.identity) return
  const highest = s.selected.messages.at(-1)?.uid ?? 0
  const going = s.selected.messages
    .map((entry, index) => ({ entry, seq: index + 1 }))
    .filter(({ entry }) => s.deleted.has(entry.uid))
    .filter(({ entry }) => uidSpec === null || inRange(uidSpec, entry.uid, highest))

  for (const { entry } of going) {
    await applyAction(s.identity.alias, entry.row.gmail_id, 'remove')
    s.deleted.delete(entry.uid)
  }
  // Descending, so each number still refers to the message the client holds.
  for (const { seq } of going.reverse()) send(s, `* ${seq} EXPUNGE`)
  reselect(s)
}

/** Read exactly `want` bytes of literal, inviting the client to send them. */
function readLiteral(s: Session, want: number): Promise<string> {
  return new Promise((resolve) => {
    s.pendingLiteral = { want, seen: '', resolve }
    send(s, '+ Ready for literal data')
  })
}

/**
 * Whether this member already sent the message being appended, matched on
 * Message-Id.
 *
 * Both the mirror and the undo queue are consulted: a client files its sent
 * copy the instant the SMTP transaction ends, seconds before the message is
 * stored. Scoped to the member rather than the open mailbox, since a client
 * appends to Sent with the inbox selected.
 */
function alreadySent(alias: string, body: string): boolean {
  const id = /^message-id:\s*(.+)$/im.exec(body)?.[1]?.trim()
  if (!id) return false

  const stored = db.prepare(`
    SELECT 1 FROM messages m
    JOIN message_owners o ON o.message_id = m.id
    WHERE o.alias = ? AND m.rfc822_id = ?
  `).get(alias, id)
  return Boolean(stored) || heldMessageIds(alias).has(id)
}

function select(s: Session, name: string): Selected | null {
  const mailbox = mailboxByName(name)
  if (!mailbox) return null
  const view = openMailbox(s.identity!.alias, mailbox)
  return { name, mailbox, ...view }
}

function untaggedStatus(s: Session, sel: Selected): void {
  const unseen = sel.messages.filter((m) => !messageStateFor(m.row.id, s.identity!.alias).read)
  send(s, `* ${sel.messages.length} EXISTS`)
  send(s, '* 0 RECENT')
  send(s, '* OK [UIDVALIDITY ' + sel.uidvalidity + '] UIDs valid')
  send(s, '* OK [UIDNEXT ' + sel.uidnext + '] Predicted next UID')
  send(s, '* FLAGS (\\Seen \\Flagged \\Draft \\Deleted)')
  send(s, '* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] Limited by what a member owns')
  if (unseen.length > 0) {
    const first = sel.messages.findIndex((m) => m.uid === unseen[0]!.uid) + 1
    send(s, `* OK [UNSEEN ${first}] First unseen`)
  }
}

/** One `BODY[...]` section of the original bytes. */
function section(raw: string, spec: string): string {
  const upper = spec.toUpperCase()
  if (upper === '') return raw
  if (upper === 'HEADER') return headerBlock(raw)
  if (upper === 'TEXT') return bodyBlock(raw)
  const fields = /^HEADER\.FIELDS(\.NOT)?\s*\((.*)\)$/i.exec(spec)
  if (fields) {
    return headerFields(raw, fields[2]!.split(/[\s,]+/).filter(Boolean), Boolean(fields[1]))
  }
  return raw
}

async function fetchItems(s: Session, entry: UidMessage, request: string): Promise<string> {
  const alias = s.identity!.alias
  const out: string[] = []
  const wants = (name: string) => new RegExp(`(^|\\s|\\()${name}(\\s|\\)|$)`, 'i').test(request)
  // Anything derived from the original is worth one fetch, not several.
  const needsRaw = /BODY(\.PEEK)?\[|BODYSTRUCTURE|RFC822/i.test(request)
  const raw = needsRaw ? await fetchRaw(entry.row.gmail_id) : ''

  if (wants('UID') || /^UID /i.test(request)) out.push(`UID ${entry.uid}`)
  if (wants('FLAGS')) out.push(`FLAGS (${flagsOf(s, entry)})`)
  if (wants('INTERNALDATE')) {
    const d = new Date(entry.row.internal_date)
    const stamp = d.toUTCString().replace(/^\w+, /, '').replace(' GMT', ' +0000')
    out.push(`INTERNALDATE ${quoted(stamp)}`)
  }
  if (wants('RFC822\\.SIZE')) out.push(`RFC822.SIZE ${raw.length}`)
  if (wants('ENVELOPE')) out.push(`ENVELOPE (${envelope(entry.row)})`)
  if (wants('BODYSTRUCTURE')) out.push(`BODYSTRUCTURE ${bodystructure(raw)}`)

  for (const m of request.matchAll(/BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi)) {
    let content = section(raw, m[2] ?? '')
    let prefix = `BODY[${m[2] ?? ''}]`
    if (m[3] !== undefined) {
      const from = Number(m[3])
      content = content.slice(from, from + Number(m[4]))
      prefix += `<${from}>`
    }
    const bytes = Buffer.from(content, 'binary')
    out.push(`${prefix} {${bytes.length}}\r\n${content}`)
  }

  return out.join(' ')
}

async function command(s: Session, tag: string, name: string, rest: string): Promise<void> {
  const verb = name.toUpperCase()

  if (verb === 'CAPABILITY') {
    send(s, `* CAPABILITY ${CAPABILITIES}`)
    send(s, `${tag} OK CAPABILITY completed`)
    return
  }
  if (verb === 'NOOP' || verb === 'CHECK') { send(s, `${tag} OK ${verb} completed`); return }
  if (verb === 'LOGOUT') {
    send(s, '* BYE LabMail signing off')
    send(s, `${tag} OK LOGOUT completed`)
    s.socket.end()
    return
  }

  if (verb === 'LOGIN' || verb === 'AUTHENTICATE') {
    if (verb === 'AUTHENTICATE' && !/^PLAIN\b/i.test(rest)) {
      send(s, `${tag} NO Only AUTHENTICATE PLAIN is supported`)
      return
    }
    let user = '', secret = ''
    if (verb === 'AUTHENTICATE') {
      let token = rest.split(/\s+/)[1] ?? ''
      if (token === '') {
        // The continuation form, which clients try first.
        token = await new Promise<string>((resolve) => {
          s.pendingContinuation = resolve
          send(s, '+ ')
        })
      }
      const parts = Buffer.from(token, 'base64').toString('utf8').split('\0')
      user = parts[1] ?? ''
      secret = parts[2] ?? ''
    } else {
      const args = rest.match(/"([^"]*)"|(\S+)/g) ?? []
      user = (args[0] ?? '').replace(/^"|"$/g, '')
      secret = (args[1] ?? '').replace(/^"|"$/g, '')
    }

    const keys = [`user:${user.trim().toLowerCase()}`, `ip:${s.ip}`]
    try {
      guard(keys)
    } catch {
      audit({ actor: user, action: 'mail.auth.throttled', ip: s.ip, detail: { protocol: 'imap' } })
      send(s, `${tag} NO [UNAVAILABLE] Too many attempts, try again later`)
      s.socket.end()
      return
    }

    const identity = await verifyMailCredential(user, secret)
    if (!identity) {
      for (const key of keys) recordFailure(key)
      audit({ actor: user, action: 'mail.auth.fail', ip: s.ip, detail: { protocol: 'imap' } })
      s.authFailures += 1
      send(s, `${tag} NO [AUTHENTICATIONFAILED] Credentials rejected`)
      if (s.authFailures >= MAX_AUTH_FAILURES) s.socket.end()
      return
    }
    for (const key of keys) recordSuccess(key)
    s.identity = identity
    audit({
      actor: identity.alias, actorId: identity.userId,
      action: 'mail.auth.ok', ip: s.ip, detail: { protocol: 'imap' },
    })
    send(s, `${tag} OK [CAPABILITY ${CAPABILITIES}] Logged in`)
    return
  }

  if (!s.identity) { send(s, `${tag} NO Authenticate first`); return }

  switch (verb) {
    case 'LIST':
    case 'LSUB': {
      const args = rest.match(/"([^"]*)"|(\S+)/g) ?? []
      const reference = (args[0] ?? '""').replace(/^"|"$/g, '')
      const pattern = (args[1] ?? '*').replace(/^"|"$/g, '')
      for (const box of IMAP_MAILBOXES) {
        if (!matchesPattern(reference + pattern, box.name)) continue
        const attrs = ['\\HasNoChildren', box.attribute].filter(Boolean).join(' ')
        send(s, `* ${verb} (${attrs}) "/" ${quoted(box.name)}`)
      }
      send(s, `${tag} OK ${verb} completed`)
      return
    }

    case 'STATUS': {
      const m = /^(?:"([^"]*)"|(\S+))\s*\((.*)\)$/.exec(rest.trim())
      const boxName = m?.[1] ?? m?.[2] ?? ''
      const sel = select(s, boxName)
      if (!sel) { send(s, `${tag} NO [NONEXISTENT] No such mailbox`); return }
      const unseen = sel.messages.filter(
        (x) => !messageStateFor(x.row.id, s.identity!.alias).read,
      ).length
      const items: string[] = []
      for (const item of (m?.[3] ?? '').toUpperCase().split(/\s+/)) {
        if (item === 'MESSAGES') items.push(`MESSAGES ${sel.messages.length}`)
        if (item === 'UIDNEXT') items.push(`UIDNEXT ${sel.uidnext}`)
        if (item === 'UIDVALIDITY') items.push(`UIDVALIDITY ${sel.uidvalidity}`)
        if (item === 'UNSEEN') items.push(`UNSEEN ${unseen}`)
        if (item === 'RECENT') items.push('RECENT 0')
      }
      send(s, `* STATUS ${quoted(boxName)} (${items.join(' ')})`)
      send(s, `${tag} OK STATUS completed`)
      return
    }

    case 'SELECT':
    case 'EXAMINE': {
      const boxName = rest.trim().replace(/^"|"$/g, '')
      const sel = select(s, boxName)
      if (!sel) { send(s, `${tag} NO [NONEXISTENT] No such mailbox`); return }
      s.selected = sel
      untaggedStatus(s, sel)
      send(s, `${tag} OK [READ-WRITE] ${verb} completed`)
      return
    }

    case 'CLOSE':
    case 'UNSELECT':
      s.selected = null
      send(s, `${tag} OK ${verb} completed`)
      return

    case 'UID':
    case 'FETCH':
    case 'SEARCH': {
      const byUid = verb === 'UID'
      const inner = byUid ? rest.trim() : `${verb} ${rest}`
      const space = inner.indexOf(' ')
      const sub = (space < 0 ? inner : inner.slice(0, space)).toUpperCase()
      const args = space < 0 ? '' : inner.slice(space + 1).trim()
      if (!s.selected) { send(s, `${tag} NO Select a mailbox first`); return }

      if (sub === 'FETCH') {
        const at = args.indexOf(' ')
        const spec = args.slice(0, at)
        const request = args.slice(at + 1).trim().replace(/^\(|\)$/g, '')
        const highest = byUid
          ? (s.selected.messages.at(-1)?.uid ?? 0)
          : s.selected.messages.length
        for (const [index, entry] of s.selected.messages.entries()) {
          const key = byUid ? entry.uid : index + 1
          if (!inRange(spec, key, highest)) continue
          const items = await fetchItems(s, entry, byUid ? `UID ${request}` : request)
          send(s, `* ${index + 1} FETCH (${items})`)
        }
        send(s, `${tag} OK FETCH completed`)
        return
      }

      if (sub === 'SEARCH') {
        const alias = s.identity.alias
        const terms = args.toUpperCase()
        const matches = s.selected.messages.filter(({ row }) => {
          const state = messageStateFor(row.id, alias)
          if (terms.includes('UNSEEN') && state.read) return false
          if (terms.includes('SEEN') && !terms.includes('UNSEEN') && !state.read) return false
          if (terms.includes('FLAGGED') && !state.starred) return false
          return true
        })
        const ids = matches.map((m) => (byUid ? m.uid : s.selected!.messages.indexOf(m) + 1))
        send(s, `* SEARCH${ids.length ? ' ' + ids.join(' ') : ''}`)
        send(s, `${tag} OK SEARCH completed`)
        return
      }

      if (sub === 'STORE') {
        const m = /^(\S+)\s+([+-]?)FLAGS(\.SILENT)?\s*\(?([^)]*)\)?/i.exec(args)
        if (!m) { send(s, `${tag} BAD Malformed STORE`); return }
        const [, spec, sign, silent, flagList] = m
        const flags = (flagList ?? '').trim().split(/\s+/).filter(Boolean).map((f) => f.toUpperCase())
        const highest = byUid
          ? (s.selected.messages.at(-1)?.uid ?? 0)
          : s.selected.messages.length

        for (const [index, entry] of s.selected.messages.entries()) {
          const key = byUid ? entry.uid : index + 1
          if (!inRange(spec!, key, highest)) continue

          for (const flag of flags) {
            if (flag === '\\DELETED') {
              // Held, not applied: IMAP removes at EXPUNGE.
              if (sign === '-') s.deleted.delete(entry.uid)
              else s.deleted.add(entry.uid)
              continue
            }
            const pair = FLAG_ACTIONS[flag]
            if (!pair) continue
            await applyAction(s.identity.alias, entry.row.gmail_id, sign === '-' ? pair.off : pair.on)
          }
          // A bare FLAGS replaces the set, so anything absent is cleared.
          if (sign === '') {
            if (!flags.includes('\\SEEN')) {
              await applyAction(s.identity.alias, entry.row.gmail_id, 'unread')
            }
            if (!flags.includes('\\FLAGGED')) {
              await applyAction(s.identity.alias, entry.row.gmail_id, 'unstar')
            }
            if (!flags.includes('\\DELETED')) s.deleted.delete(entry.uid)
          }
          if (!silent) {
            const fresh = refresh(s, entry)
            send(s, `* ${index + 1} FETCH (${byUid ? `UID ${entry.uid} ` : ''}FLAGS (${flagsOf(s, fresh)}))`)
          }
        }
        send(s, `${tag} OK STORE completed`)
        return
      }

      if (sub === 'COPY' || sub === 'MOVE') {
        const at = args.indexOf(' ')
        const spec = args.slice(0, at)
        const target = args.slice(at + 1).trim().replace(/^"|"$/g, '')
        const mailbox = mailboxByName(target)
        if (!mailbox) { send(s, `${tag} NO [TRYCREATE] No such mailbox`); return }
        const action = MOVE_ACTIONS[mailbox]
        if (action === null || action === undefined) {
          send(s, `${tag} NO [CANNOT] Messages cannot be moved into ${target}`)
          return
        }
        const highest = byUid
          ? (s.selected.messages.at(-1)?.uid ?? 0)
          : s.selected.messages.length
        const moved: number[] = []
        for (const [index, entry] of s.selected.messages.entries()) {
          const key = byUid ? entry.uid : index + 1
          if (!inRange(spec, key, highest)) continue
          await applyAction(s.identity.alias, entry.row.gmail_id, action)
          moved.push(index + 1)
        }
        if (sub === 'MOVE') {
          // The message is gone from this mailbox either way; a MOVE says so.
          for (const seq of moved.reverse()) send(s, `* ${seq} EXPUNGE`)
          reselect(s)
        }
        send(s, `${tag} OK ${sub} completed`)
        return
      }

      if (sub === 'EXPUNGE') {
        await expunge(s, byUid ? args.trim() : null)
        send(s, `${tag} OK EXPUNGE completed`)
        return
      }

      send(s, `${tag} NO [CANNOT] ${sub} is not supported`)
      return
    }

    case 'EXPUNGE':
      if (!s.selected) { send(s, `${tag} NO Select a mailbox first`); return }
      await expunge(s, null)
      send(s, `${tag} OK EXPUNGE completed`)
      return

    case 'IDLE': {
      if (!s.selected) { send(s, `${tag} NO Select a mailbox first`); return }
      // The per-alias bus the browser's live updates ride on.
      s.idle = subscribe(s.identity.alias, () => {
        reselect(s)
        send(s, `* ${s.selected?.messages.length ?? 0} EXISTS`)
      })
      send(s, '+ idling')
      await new Promise<void>((resume) => { s.pendingContinuation = () => resume() })
      s.idle?.()
      s.idle = null
      send(s, `${tag} OK IDLE terminated`)
      return
    }

    case 'APPEND': {
      const m = /^(?:"([^"]*)"|(\S+))\s+(.*)$/.exec(rest.trim())
      const target = m?.[1] ?? m?.[2] ?? ''
      const mailbox = mailboxByName(target)
      if (!mailbox) { send(s, `${tag} NO [TRYCREATE] No such mailbox`); return }

      const literal = /\{(\d+)\+?\}$/.exec(rest.trim())
      if (!literal) { send(s, `${tag} BAD APPEND needs a literal`); return }
      const body = await readLiteral(s, Number(literal[1]))

      // A client filing a copy of what it just sent, which the send path has
      // already stored. Anything else is refused rather than quietly dropped.
      if (mailbox === 'sent' && alreadySent(s.identity.alias, body)) {
        send(s, `${tag} OK [APPENDUID ${s.selected?.uidvalidity ?? 0} 1] APPEND completed`)
        return
      }
      send(s, `${tag} NO [CANNOT] This mailbox only holds mail sent through LabMail`)
      return
    }

    default:
      send(s, `${tag} BAD Command not recognized`)
  }
}

/**
 * IMAP, in front of the same per-member view the web client reads.
 *
 * Plaintext by design: TLS is terminated by whatever publishes 993, and this
 * listens on loopback.
 */
export function startImap(
  port: number, host = '127.0.0.1', proxyProtocol = false,
): Promise<Server> {
  const server = createServer((socket) => {
    const s: Session = {
      socket, ip: socket.remoteAddress ?? '', identity: null, selected: null,
      authFailures: 0, pendingContinuation: null, pendingLiteral: null,
      deleted: new Set(), idle: null,
    }
    socket.setTimeout(IDLE_MS, () => { send(s, '* BYE Idle timeout'); socket.end() })
    socket.on('error', () => socket.destroy())

    let buffer = ''
    let awaitingProxy = proxyProtocol
    if (!awaitingProxy) send(s, `* OK [CAPABILITY ${CAPABILITIES}] LabMail ready`)
    let queue = Promise.resolve()

    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary')
      if (awaitingProxy) {
        if (!buffer.startsWith('PROXY ')) { refuseProxy(socket, 'imap'); return }
        const end = buffer.indexOf('\r\n')
        if (end < 0) { if (buffer.length > 200) refuseProxy(socket, 'imap'); return }
        s.ip = buffer.split(' ')[2] ?? ''
        buffer = buffer.slice(end + 2)
        awaitingProxy = false
        send(s, `* OK [CAPABILITY ${CAPABILITIES}] LabMail ready`)
      }

      // A literal is a byte count, not a line: it can contain CRLF and must be
      // taken off the stream before anything is parsed as a command.
      while (s.pendingLiteral) {
        const need = s.pendingLiteral.want - s.pendingLiteral.seen.length
        if (buffer.length < need) {
          s.pendingLiteral.seen += buffer
          buffer = ''
          return
        }
        s.pendingLiteral.seen += buffer.slice(0, need)
        buffer = buffer.slice(need)
        const { resolve, seen } = s.pendingLiteral
        s.pendingLiteral = null
        resolve(seen)
      }

      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const text = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (text.length > MAX_LINE_BYTES) { send(s, '* BAD Line too long'); continue }
        trace('in ', 'imap', text)
        if (s.pendingContinuation) {
          const resume = s.pendingContinuation
          s.pendingContinuation = null
          resume(text.trim())
          continue
        }
        if (s.idle) continue
        const m = /^(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(text)
        if (!m) { send(s, '* BAD Malformed command'); continue }
        queue = queue
          .then(() => command(s, m[1]!, m[2]!, m[3] ?? ''))
          .catch((err) => { send(s, `${m[1]} NO ${(err as Error).message}`) })
        // The rest of the buffer belongs to a literal this command is about to
        // ask for, so stop reading lines and let the next chunk re-enter.
        if (/\{\d+\+?\}$/.test(text)) break
      }
    })
  })

  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}
