import 'dotenv/config'

/** Environment configuration. Google credentials are runtime; see core/settings.ts. */
function optional(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

const adminPassword = process.env.ADMIN_PASSWORD?.trim() ?? ''
if (!adminPassword) {
  throw new Error(
    'ADMIN_PASSWORD is required. Generate one with: openssl rand -base64 24',
  )
}
if (adminPassword.length < 12) {
  // Full mail and approval rights from the first request.
  throw new Error('ADMIN_PASSWORD must be at least 12 characters.')
}

export const config = {
  admin: {
    username: optional('ADMIN_USERNAME', 'admin').toLowerCase(),
    password: adminPassword,
    displayName: optional('ADMIN_DISPLAY_NAME', 'Administrator'),
  },
  databasePath: optional('DATABASE_PATH', './data/labmail.db'),
  port: Number(optional('PORT', '8000')),
  /** Public origin for the OAuth redirect. Falls back to the request Host. */
  publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/$/, '') || null,
  /** Audit retention in days. 0 keeps everything. */
  auditRetentionDays: Number(optional('AUDIT_RETENTION_DAYS', '365')),
} as const

/** Scopes for the shared account. */
export const GOOGLE_SCOPES = [
  // Excludes permanent deletion; mail stays recoverable in Trash.
  'https://www.googleapis.com/auth/gmail.modify',
  // Send-as entries: read through settings.basic, removed through sharing.
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  // Member addresses are Groups delivering to the shared account.
  'https://www.googleapis.com/auth/admin.directory.group',
  // Directory reads: whether an address is already claimed.
  'https://www.googleapis.com/auth/admin.directory.user',
  // drive.file, not drive: reaches only what labMail created.
  'https://www.googleapis.com/auth/drive.file',
]

