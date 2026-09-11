import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.ts'
import { db, backfillMessageState } from '../db/index.ts'
import { hashPassword, purgeExpiredSessions } from '../core/auth.ts'
import { UserError } from '../core/users.ts'
import { getSetting, isGoogleConnected, syncIntervalSeconds } from '../core/settings.ts'
import { reconcileSendAs } from '../core/users.ts'
import { currentHistoryId, fullSync, incrementalSync, reresolveUnassigned, linkDrafts } from '../google/sync.ts'
import { recordSyncOk, recordSyncError, syncHealth } from '../core/sync-status.ts'
import { resumeHeldSends } from '../google/outbox.ts'
import { DEFAULT_LOCALE, resolveLocale, t, type MessageKey } from '../core/i18n.ts'
import { HttpError, json } from './http.ts'
import { createRouter } from './routes/index.ts'
import { sweepThrottles } from '../core/throttle.ts'
import { pruneAudit } from '../core/audit.ts'

const SESSION_SWEEP_MS = 3_600_000

/**
 * The operator account from the environment: the only entry into a fresh
 * deployment. Created without an alias, the domain not yet being known.
 */
async function bootstrapAdmin(): Promise<void> {
  // Matched on the address too: sign-in names are addresses once one has been
  // assigned, and looking only for the bare name would create a second account
  // beside the operator's own.
  const existing = db.prepare(`
    SELECT id FROM users
    WHERE lower(username) = ?
       OR lower(alias_email) = ?
       OR lower(substr(alias_email, 1, instr(alias_email, '@') - 1)) = ?
  `).get(
    config.admin.username,
    config.admin.username,
    config.admin.username,
  ) as { id: number } | undefined

  if (existing) {
    // The environment seeds the account; it does not override a changed password.
    db.prepare(`UPDATE users SET is_admin = 1, status = 'active' WHERE id = ?`).run(existing.id)
    return
  }

  db.prepare(`
    INSERT INTO users (username, display_name, alias_email, password_hash, status, is_admin, approved_at)
    VALUES (?, ?, NULL, ?, 'active', 1, datetime('now'))
  `).run(config.admin.username, config.admin.displayName, await hashPassword(config.admin.password))

  console.log(`[boot] created admin account "${config.admin.username}"`)
}

/**
 * Periodic sync, in-process so a deployment stays one container.
 * No-op until Google is connected; never overlaps itself.
 */
let syncing = false

async function syncTick(): Promise<void> {
  if (syncing || !isGoogleConnected()) return
  syncing = true
  try {
    const result = currentHistoryId() ? await incrementalSync() : { changed: await fullSync() }
    const assigned = reresolveUnassigned()
    await linkDrafts()
    // Send-as entries change outside labMail; one request per tick notices.
    await reconcileSendAs()
    if (result.changed > 0 || assigned > 0) {
      console.log(`[sync] ${result.changed} changed, ${assigned} newly attributed`)
    }
    recordSyncOk()
  } catch (err) {
    const message = (err as Error).message
    recordSyncError(message)
    const { consecutiveFailures } = syncHealth()
    // Loud on the first failure, then at widening intervals.
    if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
      console.error(`[sync] failed (${consecutiveFailures}x): ${message}`)
    }
  } finally {
    syncing = false
  }
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status
  if (err instanceof UserError) return err.status
  const status = (err as { status?: number })?.status
  return typeof status === 'number' ? status : 500
}

/**
 * Error text in the caller's language. Errors from this codebase carry a
 * message key; anything else keeps its original text.
 */
function messageOf(err: unknown, locale: Parameters<typeof t>[0]): string {
  const key = (err as { key?: MessageKey })?.key
  if (key) return t(locale, key, (err as { params?: Record<string, string> })?.params ?? {})
  return (err as Error)?.message || t(locale, 'error.internal')
}

/**
 * Boot the service and resolve once it is accepting connections.
 *
 * Returns the server and takes an explicit port so tests can bind an ephemeral
 * one; port 0 asks the OS to choose.
 */
export async function start(port: number = config.port): Promise<Server> {
  // Rows written before per-member state existed, or by an older build.
  const seeded = backfillMessageState()
  if (seeded > 0) console.log(`[boot] seeded per-member state for ${seeded} message(s)`)

  await bootstrapAdmin()

  // Holds that outlived the last stop are owed to whoever pressed Send.
  const resumed = resumeHeldSends()
  if (resumed > 0) console.log(`[boot] resumed ${resumed} held send(s)`)
  const router = createRouter()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    Promise.resolve(router.handle(req, res, url)).catch((err: unknown) => {
      const status = statusOf(err)
      if (status >= 500) console.error('[web]', err)
      // A 4xx from Google reaches the browser as Google's own wording, which
      // names no call and no id. Logged with the request that produced it, or
      // the next report is another search.
      else if (!(err as { key?: unknown })?.key) {
        console.error(`[web] ${req.method} ${url.pathname} -> ${status}: ${(err as Error).message}`)
      }
      if (res.headersSent) { res.end(); return }
      const locale = status >= 500 ? DEFAULT_LOCALE : resolveLocale(req)
      json(res, status, { error: messageOf(err, locale) })
    })
  })

  setInterval(purgeExpiredSessions, SESSION_SWEEP_MS).unref()
  setInterval(sweepThrottles, SESSION_SWEEP_MS).unref()
  // Daily and on boot: an unbounded access log fills the volume.
  const pruneDaily = () => {
    const dropped = pruneAudit(config.auditRetentionDays)
    if (dropped > 0) console.log(`[audit] pruned ${dropped} entries past ${config.auditRetentionDays} days`)
  }
  pruneDaily()
  setInterval(pruneDaily, 24 * 60 * 60_000).unref()
  setInterval(() => { void syncTick() }, syncIntervalSeconds() * 1000).unref()

  // 0.0.0.0: reachable at the host IP, not only loopback.
  await new Promise<void>((ready) => server.listen(port, '0.0.0.0', ready))

  if (port === config.port) {
    console.log(`labMail listening on http://0.0.0.0:${port}`)
    // Started alongside rather than in its own process: it shares the database,
    // the send path and the throttle, and a deployment stays one container.
    if (config.smtpPort > 0) {
      const { startSmtp } = await import('../mail/smtp.ts')
      await startSmtp(config.smtpPort, config.smtpHost, config.smtpProxyProtocol)
      console.log(`  SMTP submission on ${config.smtpHost}:${config.smtpPort}`)
    }
    if (config.imapPort > 0) {
      const { startImap } = await import('../mail/imap.ts')
      await startImap(config.imapPort, config.imapHost, config.imapProxyProtocol)
      console.log(`  IMAP on ${config.imapHost}:${config.imapPort}`)
    }
    console.log(isGoogleConnected()
      ? `  Google: connected (${getSetting('shared_account_email')}, @${getSetting('org_domain')})`
      : '  Google: not configured — sign in as admin and open system settings')
  }
  return server
}

// Only when executed directly, so tests can import `start` and bind their own.
const executedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (executedDirectly) await start()
