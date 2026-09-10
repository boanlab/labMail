import { db } from '../db/index.ts'
import { DEFAULT_LOCALE, t } from './i18n.ts'

/**
 * Runtime configuration, stored in the database.
 *
 * None of these can be required at boot, so consumers read at call time rather
 * than capturing values at import.
 */
export const SETTING_KEYS = [
  'google_client_id',
  'google_client_secret',
  'google_refresh_token',
  'shared_account_email',
  'org_domain',
  'sync_interval_seconds',
  'undo_send_seconds',
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

/** Never sent to the browser, even to an admin. */
export const SECRET_KEYS: SettingKey[] = ['google_client_secret', 'google_refresh_token']

const listeners: (() => void)[] = []

/** Invalidate memoized consumers, notably the OAuth client. */
export function onSettingsChanged(fn: () => void): void {
  listeners.push(fn)
}

export function getSetting(key: SettingKey): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function requireSetting(key: SettingKey): string {
  const value = getSetting(key)
  if (!value) {
    throw Object.assign(new Error(t(DEFAULT_LOCALE, 'setup.missingSetting', { key })), {
      status: 409,
      key: 'setup.missingSetting' as const,
      params: { key },
    })
  }
  return value
}

export function setSetting(key: SettingKey, value: string): void {
  const trimmed = value.trim()
  if (!trimmed) {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(key)
  } else {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, trimmed)
  }
  for (const fn of listeners) fn()
}

export function setSettings(values: Partial<Record<SettingKey, string>>): void {
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (SETTING_KEYS.includes(key as SettingKey)) {
        const trimmed = (value ?? '').trim()
        if (!trimmed) {
          db.prepare(`DELETE FROM settings WHERE key = ?`).run(key)
        } else {
          db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
          `).run(key, trimmed)
        }
      }
    }
  })()
  for (const fn of listeners) fn()
}

export function orgDomain(): string {
  return requireSetting('org_domain').toLowerCase()
}

export function sharedAccountEmail(): string {
  return requireSetting('shared_account_email').toLowerCase()
}

/** Seconds a send is held so it can be recalled. 0 disables the window. */
export function undoSendSeconds(): number {
  const raw = Number(getSetting('undo_send_seconds') ?? 10)
  if (!Number.isFinite(raw) || raw < 0) return 10
  return Math.min(raw, 60)
}

export function syncIntervalSeconds(): number {
  const raw = Number(getSetting('sync_interval_seconds') ?? 60)
  return Number.isFinite(raw) && raw >= 15 ? raw : 60
}

/** Sufficient to start an OAuth consent flow. */
export function hasOAuthClient(): boolean {
  return Boolean(getSetting('google_client_id') && getSetting('google_client_secret'))
}

/** Sufficient to reach the mailbox. */
export function isGoogleConnected(): boolean {
  return Boolean(
    hasOAuthClient() &&
    getSetting('google_refresh_token') &&
    getSetting('shared_account_email') &&
    getSetting('org_domain'),
  )
}

/** Admin UI snapshot. Secrets reported as set/unset, never by value. */
export function publicSettings(): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {}
  for (const key of SETTING_KEYS) {
    out[key] = SECRET_KEYS.includes(key) ? Boolean(getSetting(key)) : getSetting(key)
  }
  out.connected = isGoogleConnected()
  return out
}
