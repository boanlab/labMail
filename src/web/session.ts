import type { IncomingMessage } from 'node:http'
import { loadSession, type SessionUser } from '../core/auth.ts'
import { canSend } from '../core/users.ts'
import { config } from '../config.ts'
import { COOKIE_NAME, HttpError, cookies } from './http.ts'

/** Signed-in user, or 401. */
export function requireUser(req: IncomingMessage): SessionUser {
  const user = loadSession(cookies(req)[COOKIE_NAME])
  if (!user) throw new HttpError(401, 'error.notSignedIn')
  return user
}

export type MailboxUser = SessionUser & { alias: string }

/**
 * A user with a mailbox. Refuses rather than falling back to a default scope,
 * which would read the whole mailbox.
 */
export function requireMailbox(req: IncomingMessage): MailboxUser {
  const user = requireUser(req)
  if (!user.alias) {
    throw new HttpError(409, 'mailbox.noAddress')
  }
  return user as MailboxUser
}

/**
 * A user who can also send.
 *
 * Sending needs a send-as entry on the shared account, added by hand: the API
 * that creates one is restricted to service accounts holding domain-wide
 * authority. Without it Gmail rewrites From to the shared account, so the
 * recipient would see the mailbox rather than the member.
 */
export function requireSender(req: IncomingMessage): MailboxUser {
  const user = requireMailbox(req)
  if (!canSend(user.id)) throw new HttpError(409, 'mailbox.sendNotReady')
  return user
}

export function requireAdmin(req: IncomingMessage): SessionUser {
  const user = requireUser(req)
  if (!user.isAdmin) throw new HttpError(403, 'error.adminOnly')
  return user
}

/**
 * Origin for absolute URLs, chiefly the OAuth redirect.
 *
 * Defaults to the request Host, so access by host IP needs no configuration.
 * `PUBLIC_URL` overrides it behind a proxy that rewrites Host.
 */
export function originOf(req: IncomingMessage): string {
  if (config.publicUrl) return config.publicUrl
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || 'http'
  const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim()
    || req.headers.host
    || `localhost:${config.port}`
  return `${proto}://${host}`
}

/** Whether the request reached us over TLS, through a proxy or directly. */
export function isSecureRequest(req: IncomingMessage): boolean {
  return originOf(req).startsWith('https://')
}

export const redirectUriFor = (req: IncomingMessage): string =>
  `${originOf(req)}/api/admin/oauth/callback`
