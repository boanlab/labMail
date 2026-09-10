import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { getSetting, requireSetting, onSettingsChanged } from '../core/settings.ts'

let cached: OAuth2Client | null = null

// Credentials are editable at runtime; the memoized client must not outlive them.
onSettingsChanged(() => { cached = null })

/** Client for the consent flow, before a token exists. */
export function oauthClient(redirectUri: string): OAuth2Client {
  return new google.auth.OAuth2(
    requireSetting('google_client_id'),
    requireSetting('google_client_secret'),
    redirectUri,
  )
}

/**
 * The single credential for the shared mailbox.
 *
 * All Gmail access runs through this token. Members never hold Google
 * credentials, which is what keeps them out of the Gmail web UI.
 */
export function sharedAccountAuth(): OAuth2Client {
  if (cached) return cached
  const client = new google.auth.OAuth2(
    requireSetting('google_client_id'),
    requireSetting('google_client_secret'),
  )
  client.setCredentials({ refresh_token: requireSetting('google_refresh_token') })
  cached = client
  return client
}

export function gmail() {
  return google.gmail({ version: 'v1', auth: sharedAccountAuth() })
}

export function admin() {
  return google.admin({ version: 'directory_v1', auth: sharedAccountAuth() })
}

export function isConnected(): boolean {
  return Boolean(getSetting('google_refresh_token'))
}
