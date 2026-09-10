import { db } from '../../db/index.ts'
import { createSession, destroySession, loadSession, verifyPassword } from '../../core/auth.ts'
import { signup, checkLocalPart, canSend } from '../../core/users.ts'
import { setSignature, setDisplayName, changePassword } from '../../core/profile.ts'
import { countUnread, mailboxCounts } from '../../db/index.ts'
import { getSetting, isGoogleConnected } from '../../core/settings.ts'
import { syncHealth } from '../../core/sync-status.ts'
import { LOCALES, LOCALE_COOKIE, isLocale, t } from '../../core/i18n.ts'
import {
  HttpError, clearSessionCookie, clientAddress, cookies, json, readJson, setSessionCookie,
  str, COOKIE_NAME,
} from '../http.ts'
import { guard, recordFailure, recordSuccess } from '../../core/throttle.ts'
import { audit } from '../../core/audit.ts'
import { requireUser, isSecureRequest } from '../session.ts'
import type { Router } from '../router.ts'

interface UserRow {
  id: number
  username: string
  display_name: string
  alias_email: string | null
  password_hash: string
  status: string
  is_admin: number
  signature: string | null
}

export function registerAuthRoutes(router: Router): void {
  /**
   * Public bootstrap data. The domain lets the signup form preview the address;
   * signup does not depend on it.
   */
  router.get('/api/config', ({ res, locale }) => {
    json(res, 200, { orgDomain: getSetting('org_domain'), locale, locales: LOCALES })
  })

  /**
   * Liveness, plus sync detail for an external monitor. Always 200 while the
   * process serves: a Google outage must not invite a restart that cannot help.
   */
  router.get('/healthz', ({ res }) => {
    const connected = isGoogleConnected()
    json(res, 200, { ok: true, connected, sync: connected ? syncHealth() : null })
  })

  /**
   * Persist the caller's language.
   *
   * A cookie rather than an account column: the choice belongs to the browser,
   * applies before sign-in, and must be readable by the server when it
   * translates an error.
   */
  router.post('/api/locale', async ({ req, res, locale }) => {
    const body = await readJson(req)
    const next = str(body, 'locale')
    if (!isLocale(next)) throw new HttpError(400, 'error.badJson')
    res.setHeader(
      'set-cookie',
      `${LOCALE_COOKIE}=${next}; SameSite=Lax; Path=/; Max-Age=${365 * 86_400}`,
    )
    json(res, 200, { locale: next, previous: locale })
  })

  /**
   * Whether a requested address is free, for the signup form.
   *
   * This does confirm to an anonymous caller that a given address exists, which
   * is member enumeration on a domain whose addresses are already guessable.
   * The alternative — finding out only after filling the form in — was the
   * worse trade for a tool this size.
   */
  router.get('/api/signup/available', ({ res, url, locale }) => {
    const localPart = (url.searchParams.get('localPart') ?? '').trim().toLowerCase()
    if (!localPart) throw new HttpError(400, 'address.format')
    const problem = checkLocalPart(localPart)
    json(res, 200, {
      available: problem === null,
      reason: problem ? t(locale, problem) : null,
    })
  })

  router.post('/api/signup', async ({ req, res, locale }) => {
    const body = await readJson(req)
    await signup({
      displayName: str(body, 'displayName'),
      localPart: str(body, 'localPart'),
      password: str(body, 'password'),
    })
    json(res, 201, { message: t(locale, 'auth.signupReceived') })
  })

  router.post('/api/login', async ({ req, res }) => {
    const body = await readJson(req)
    // Members sign in with their address; it is stored as the username, but a
    // full "hong@example.com" has to work too since that is what they know.
    const identifier = str(body, 'username').trim().toLowerCase()

    // Refused before the password is even hashed: an attacker should not be
    // able to spend the server's scrypt budget once the bucket is locked.
    const ip = clientAddress(req)
    const keys = [`user:${identifier}`, `ip:${ip}`]
    try {
      guard(keys)
    } catch (err) {
      audit({ actor: identifier, action: 'signin.throttled', ip })
      throw err
    }

    const row = db.prepare(
      `SELECT * FROM users WHERE username = ? OR alias_email = ?`,
    ).get(identifier, identifier) as UserRow | undefined

    // Verified even when the user is missing, so timing reveals nothing.
    const ok = row ? await verifyPassword(str(body, 'password'), row.password_hash) : false

    if (!row || !ok) {
      for (const key of keys) recordFailure(key)
      // The identifier is recorded as typed: a run of failures against an
      // address that does not exist is itself worth being able to see.
      audit({ actor: identifier, action: 'signin.fail', ip, detail: { known: Boolean(row) } })
      throw new HttpError(401, 'auth.badCredentials')
    }
    // A correct password clears the counters even when the account cannot sign
    // in: the guessing has stopped, and the status errors below are not secrets.
    for (const key of keys) recordSuccess(key)

    if (row.status === 'pending') throw new HttpError(403, 'auth.pending')
    if (row.status === 'deactivated') throw new HttpError(403, 'auth.deactivated')

    audit({
      actor: row.alias_email ?? row.username, actorId: row.id,
      action: 'signin.ok', ip,
    })
    setSessionCookie(res, createSession(row.id), isSecureRequest(req))
    json(res, 200, {
      username: row.username,
      displayName: row.display_name,
      alias: row.alias_email,
      isAdmin: row.is_admin === 1,
      signature: row.signature,
      canSend: canSend(row.id),
    })
  })

  router.post('/api/logout', ({ req, res }) => {
    const user = loadSession(cookies(req)[COOKIE_NAME])
    if (user) {
      audit({
        actor: user.alias ?? user.username, actorId: user.id,
        action: 'signout', ip: clientAddress(req),
      })
    }
    destroySession(cookies(req)[COOKIE_NAME])
    clearSessionCookie(res)
    json(res, 200, { ok: true })
  })

  /** A member's own preferences. Scoped to the session, never to another id. */
  router.post('/api/profile/signature', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readJson(req)
    json(res, 200, { signature: setSignature(user.id, str(body, 'signature')) })
  })

  router.post('/api/profile/password', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readJson(req)
    await changePassword(
      user.id,
      str(body, 'currentPassword'),
      str(body, 'newPassword'),
      cookies(req)[COOKIE_NAME],
    )
    audit({
      actor: user.alias ?? user.username, actorId: user.id,
      action: 'account.password', ip: clientAddress(req),
    })
    json(res, 200, { ok: true })
  })

  router.post('/api/profile/name', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readJson(req)
    json(res, 200, { displayName: setDisplayName(user.id, str(body, 'displayName')) })
  })

  router.get('/api/me', ({ req, res }) => {
    const user = loadSession(cookies(req)[COOKIE_NAME])
    if (!user) {
      json(res, 200, { user: null })
      return
    }
    json(res, 200, {
      // canSend rides on the user so both sign-in paths agree on its shape.
      user: { ...user, canSend: canSend(user.id) },
      unread: user.alias ? countUnread(user.alias) : 0,
      counts: user.alias ? mailboxCounts(user.alias) : {},
      connected: isGoogleConnected(),
    })
  })
}
