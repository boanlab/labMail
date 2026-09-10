import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_LOCALE, t, type MessageKey } from '../core/i18n.ts'

/**
 * Error carrying the HTTP status and a translatable message key.
 *
 * Translation happens once, in the response handler, using the request locale;
 * throw sites stay locale-agnostic. `message` holds the default-locale text so
 * logs and stack traces remain readable.
 */
export class HttpError extends Error {
  status: number
  key: MessageKey
  params: Record<string, string | number>

  constructor(status: number, key: MessageKey, params: Record<string, string | number> = {}) {
    super(t(DEFAULT_LOCALE, key, params))
    this.status = status
    this.key = key
    this.params = params
    this.name = 'HttpError'
  }
}

export const COOKIE_NAME = 'labmail_session'
export const SESSION_MAX_AGE_SECONDS = 14 * 86_400

/** Body limit, sized for a mail with attachments. */
export const BODY_LIMIT_BYTES = 30 * 1024 * 1024

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

export async function readJson(
  req: IncomingMessage,
  limitBytes = BODY_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new HttpError(413, 'error.tooLarge')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'error.badJson')
  }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key) out[key] = decodeURIComponent(rest.join('='))
  }
  return out
}

/**
 * The client address, as seen through whatever terminates TLS.
 *
 * The left-most X-Forwarded-For entry is the original client; the proxy in
 * front is trusted because it is the only thing that can reach this port in a
 * correct deployment. Falls back to the socket for a direct connection.
 */
export function clientAddress(req: IncomingMessage): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
  return forwarded || req.socket.remoteAddress || 'unknown'
}

export function setSessionCookie(
  res: ServerResponse, token: string, secure = false,
): void {
  res.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/`
    + `${secure ? '; Secure' : ''}; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  )
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

/** String field from an untyped JSON body. */
export function str(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key]
  return typeof value === 'string' ? value : fallback
}

/** String array from an untyped JSON body. */
export function strArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}
