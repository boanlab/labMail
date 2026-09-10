import { randomBytes } from 'node:crypto'
import { GOOGLE_SCOPES } from '../../config.ts'
import { oauthClient } from '../../google/client.ts'
import { hasOAuthClient, setSetting } from '../../core/settings.ts'
import { HttpError, json, clientAddress } from '../http.ts'
import { audit } from '../../core/audit.ts'
import { requireAdmin, redirectUriFor } from '../session.ts'
import type { Router } from '../router.ts'

/** Pending consent flows by `state`. In-memory; a restart invalidates them. */
const pendingStates = new Map<string, number>()
const STATE_TTL_MS = 10 * 60_000

function issueState(): string {
  const now = Date.now()
  for (const [key, expiry] of pendingStates) if (expiry < now) pendingStates.delete(key)
  const state = randomBytes(24).toString('base64url')
  pendingStates.set(state, now + STATE_TTL_MS)
  return state
}

function consumeState(state: string | null): boolean {
  if (!state) return false
  const expiry = pendingStates.get(state)
  pendingStates.delete(state)          // single use, valid or not
  return expiry !== undefined && expiry > Date.now()
}

export function registerOAuthRoutes(router: Router): void {
  router.get('/api/admin/oauth/start', ({ req, res }) => {
    requireAdmin(req)
    if (!hasOAuthClient()) throw new HttpError(409, 'oauth.noClient')

    const authUrl = oauthClient(redirectUriFor(req)).generateAuthUrl({
      access_type: 'offline',
      // Forces a refresh token, which Google omits on repeat consent.
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
      state: issueState(),
    })
    res.writeHead(302, { location: authUrl })
    res.end()
  })

  router.get('/api/admin/oauth/callback', async ({ req, res, url }) => {
    const admin = requireAdmin(req)

    const error = url.searchParams.get('error')
    if (error) throw new HttpError(400, 'oauth.denied', { reason: error })
    if (!consumeState(url.searchParams.get('state'))) {
      throw new HttpError(400, 'oauth.stateExpired')
    }
    const code = url.searchParams.get('code')
    if (!code) throw new HttpError(400, 'oauth.noCode')

    const { tokens } = await oauthClient(redirectUriFor(req)).getToken(code)
    if (!tokens.refresh_token) {
      throw new HttpError(400, 'oauth.noRefreshToken')
    }
    setSetting('google_refresh_token', tokens.refresh_token)
    audit({
      actor: admin.alias ?? admin.username, actorId: admin.id,
      action: 'google.connect', ip: clientAddress(req),
    })

    res.writeHead(302, { location: '/?connected=1' })
    res.end()
  })

  router.post('/api/admin/oauth/disconnect', ({ req, res }) => {
    const admin = requireAdmin(req)
    setSetting('google_refresh_token', '')
    audit({
      actor: admin.alias ?? admin.username, actorId: admin.id,
      action: 'google.disconnect', ip: clientAddress(req),
    })
    json(res, 200, { ok: true })
  })
}
