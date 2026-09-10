import { createServer, type Server, type Socket } from 'node:net'
import { hold } from '../google/outbox.ts'
import { toBase64Url } from '../google/mime.ts'
import { isValidAddress, parseSingleAddress } from '../google/addresses.ts'
import { audit } from '../core/audit.ts'
import { guard, recordFailure, recordSuccess } from '../core/throttle.ts'
import { isGoogleConnected } from '../core/settings.ts'
import { verifyMailCredential, type MailIdentity } from './credentials.ts'
import { rewriteSubmission } from './rewrite.ts'

/** Submission only: this server never accepts mail for delivery elsewhere. */
const GREETING = 'labMail submission'

const MAX_MESSAGE_BYTES = 26_214_400   // 25 MiB, the limit Gmail itself imposes
const MAX_RECIPIENTS = 100
const MAX_LINE_BYTES = 4_000           // RFC 5321 allows 1000; headroom for clients
const MAX_AUTH_FAILURES = 3
const IDLE_MS = 5 * 60_000

type Phase = 'command' | 'data' | 'auth-user' | 'auth-pass' | 'auth-plain'

interface Session {
  socket: Socket
  ip: string
  identity: MailIdentity | null
  from: string | null
  rcpt: string[]
  phase: Phase
  authUser: string
  authFailures: number
  data: string[]
  dataBytes: number
  oversize: boolean
}

const write = (s: Session, line: string): void => {
  trace('out', 'smtp', line)
  s.socket.write(line + '\r\n')
}

/**
 * Real client address from a PROXY protocol v1 header. Without it every session
 * looks like loopback, collapsing the per-address throttle into one bucket.
 * Null while the header is still incomplete.
 */
function proxyLine(chunk: string): { ip: string; rest: string } | null {
  const end = chunk.indexOf('\r\n')
  if (end < 0) return null
  const parts = chunk.slice(0, end).split(' ')
  return { ip: parts[2] ?? '', rest: chunk.slice(end + 2) }
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

function reset(s: Session): void {
  s.from = null
  s.rcpt = []
  s.data = []
  s.dataBytes = 0
  s.oversize = false
}

/** `<addr>` or `<addr> PARAM=value`, per RFC 5321. */
function pathOf(argument: string): string | null {
  const open = argument.indexOf('<')
  const close = argument.indexOf('>', open + 1)
  if (open < 0 || close < 0) return null
  return argument.slice(open + 1, close).trim()
}

async function authenticate(s: Session, username: string, secret: string): Promise<void> {
  const keys = [`user:${username.trim().toLowerCase()}`, `ip:${s.ip}`]
  try {
    guard(keys)
  } catch {
    audit({ actor: username, action: 'mail.auth.throttled', ip: s.ip, detail: { protocol: 'smtp' } })
    write(s, '454 4.7.0 Too many attempts, try again later')
    s.socket.end()
    return
  }

  const identity = await verifyMailCredential(username, secret)
  if (!identity) {
    for (const key of keys) recordFailure(key)
    audit({ actor: username, action: 'mail.auth.fail', ip: s.ip, detail: { protocol: 'smtp' } })
    s.authFailures += 1
    write(s, '535 5.7.8 Authentication credentials invalid')
    if (s.authFailures >= MAX_AUTH_FAILURES) s.socket.end()
    return
  }

  for (const key of keys) recordSuccess(key)
  s.identity = identity
  audit({
    actor: identity.alias, actorId: identity.userId,
    action: 'mail.auth.ok', ip: s.ip, detail: { protocol: 'smtp' },
  })
  write(s, '235 2.7.0 Authentication successful')
}

function deliver(s: Session): void {
  const identity = s.identity!
  const raw = s.data.join('\r\n')
  const { raw: rewritten } = rewriteSubmission(raw, identity, s.rcpt)
  const { pendingId, undoSeconds } = hold(identity.alias, toBase64Url(rewritten))

  audit({
    actor: identity.alias, actorId: identity.userId, action: 'message.send',
    ip: s.ip, detail: { protocol: 'smtp', recipients: s.rcpt.length, undoSeconds },
  })
  write(s, `250 2.0.0 Queued as ${pendingId}`)
  reset(s)
}

async function command(s: Session, line: string): Promise<void> {
  const space = line.indexOf(' ')
  const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase()
  const rest = space < 0 ? '' : line.slice(space + 1).trim()

  switch (verb) {
    case 'EHLO':
      write(s, '250-labMail')
      write(s, `250-SIZE ${MAX_MESSAGE_BYTES}`)
      write(s, '250-8BITMIME')
      write(s, '250-AUTH PLAIN LOGIN')
      write(s, '250 HELP')
      return
    case 'HELO':
      write(s, '250 labMail')
      return

    case 'AUTH': {
      if (s.identity) { write(s, '503 5.5.1 Already authenticated'); return }
      const [mechanism, initial] = rest.split(/\s+/, 2)
      const kind = (mechanism ?? '').toUpperCase()
      if (kind === 'PLAIN') {
        if (initial) return await plain(s, initial)
        s.phase = 'auth-plain'
        write(s, '334 ')
        return
      }
      if (kind === 'LOGIN') {
        s.phase = 'auth-user'
        write(s, '334 VXNlcm5hbWU6')          // "Username:"
        return
      }
      // Named in the log: a client refused a mechanism usually gives up and
      // sends unauthenticated, which surfaces with nothing to explain it.
      console.error(
        `[smtp] ${s.ip} asked for AUTH ${kind || '(none)'}; this server offers PLAIN and LOGIN`,
      )
      write(s, '504 5.5.4 Unrecognized authentication type')
      return
    }

    case 'MAIL': {
      if (!s.identity) { write(s, '530 5.7.0 Authentication required'); return }
      if (!s.identity.canSend) {
        write(s, '550 5.7.1 This address cannot send mail yet')
        return
      }
      if (!isGoogleConnected()) { write(s, '451 4.3.0 Mail service unavailable'); return }
      if (!/^FROM:/i.test(rest)) { write(s, '501 5.5.4 Syntax: MAIL FROM:<address>'); return }
      // Recorded but not honoured: From is the authenticated member either way.
      s.from = pathOf(rest) ?? ''
      s.rcpt = []
      write(s, '250 2.1.0 Sender accepted')
      return
    }

    case 'RCPT': {
      if (!s.from) { write(s, '503 5.5.1 MAIL first'); return }
      if (!/^TO:/i.test(rest)) { write(s, '501 5.5.4 Syntax: RCPT TO:<address>'); return }
      const address = pathOf(rest)
      if (!address || !isValidAddress(address)) {
        write(s, '501 5.1.3 Bad recipient address')
        return
      }
      if (s.rcpt.length >= MAX_RECIPIENTS) { write(s, '452 4.5.3 Too many recipients'); return }
      s.rcpt.push(address)
      write(s, '250 2.1.5 Recipient accepted')
      return
    }

    case 'DATA':
      if (!s.from) { write(s, '503 5.5.1 MAIL first'); return }
      if (s.rcpt.length === 0) { write(s, '554 5.5.1 No recipients'); return }
      s.phase = 'data'
      s.data = []
      s.dataBytes = 0
      s.oversize = false
      write(s, '354 End data with <CR><LF>.<CR><LF>')
      return

    case 'RSET':
      reset(s)
      write(s, '250 2.0.0 Reset')
      return
    case 'NOOP':
      write(s, '250 2.0.0 OK')
      return
    case 'QUIT':
      write(s, '221 2.0.0 Bye')
      s.socket.end()
      return
    // Deliberately uninformative: this server knows every member address.
    case 'VRFY':
    case 'EXPN':
      write(s, '252 2.5.2 Cannot verify')
      return
    default:
      write(s, '502 5.5.2 Command not recognized')
  }
}

async function plain(s: Session, token: string): Promise<void> {
  const parts = Buffer.from(token, 'base64').toString('utf8').split('\0')
  s.phase = 'command'
  if (parts.length < 3) { write(s, '501 5.5.2 Malformed AUTH PLAIN'); return }
  await authenticate(s, parts[1]!, parts[2]!)
}

async function line(s: Session, text: string): Promise<void> {
  switch (s.phase) {
    case 'auth-plain':
      return await plain(s, text)
    case 'auth-user':
      s.authUser = Buffer.from(text, 'base64').toString('utf8')
      s.phase = 'auth-pass'
      write(s, '334 UGFzc3dvcmQ6')            // "Password:"
      return
    case 'auth-pass': {
      s.phase = 'command'
      await authenticate(s, s.authUser, Buffer.from(text, 'base64').toString('utf8'))
      return
    }
    case 'data': {
      if (text === '.') {
        s.phase = 'command'
        if (s.oversize) {
          write(s, '552 5.3.4 Message too large')
          reset(s)
          return
        }
        deliver(s)
        return
      }
      // Dot-stuffing: a body line that began with '.' arrives doubled.
      const content = text.startsWith('..') ? text.slice(1) : text
      s.dataBytes += content.length + 2
      if (s.dataBytes > MAX_MESSAGE_BYTES) { s.oversize = true; return }
      s.data.push(content)
      return
    }
    default:
      return await command(s, text)
  }
}

/**
 * SMTP submission, in front of the send path the composer uses. Plaintext by
 * design: TLS belongs to whatever publishes 465. Every session authenticates,
 * and the message goes out as that member.
 */
export function startSmtp(
  port: number, host = '127.0.0.1', proxyProtocol = false,
): Promise<Server> {
  const server = createServer((socket) => {
    const s: Session = {
      socket, ip: socket.remoteAddress ?? '', identity: null, from: null, rcpt: [],
      phase: 'command', authUser: '', authFailures: 0, data: [], dataBytes: 0, oversize: false,
    }
    socket.setTimeout(IDLE_MS, () => { write(s, '421 4.4.2 Idle timeout'); socket.end() })
    socket.on('error', () => socket.destroy())

    let buffer = ''
    // The server speaks first, so the greeting waits on nothing except a
    // PROXY header, which the deployment declares.
    let awaitingProxy = proxyProtocol
    if (!awaitingProxy) write(s, `220 ${GREETING}`)
    let queue = Promise.resolve()

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (awaitingProxy) {
        if (!buffer.startsWith('PROXY ')) { refuseProxy(socket, 'smtp'); return }
        const proxied = proxyLine(buffer)
        if (!proxied) {
          if (buffer.length > 200) refuseProxy(socket, 'smtp')
          return
        }
        s.ip = proxied.ip
        buffer = proxied.rest
        awaitingProxy = false
        write(s, `220 ${GREETING}`)
      }

      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const text = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (text.length > MAX_LINE_BYTES && s.phase !== 'data') {
          write(s, '500 5.5.6 Line too long')
          continue
        }
        if (s.phase !== 'data') trace('in ', 'smtp', text)
        // Serialized: authentication is async, and a client that pipelines
        // must not have its DATA interpreted as a command.
        queue = queue.then(() => line(s, text)).catch(() => { socket.destroy() })
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server))
  })
}
