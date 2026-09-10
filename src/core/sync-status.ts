/**
 * Last sync outcome, held in memory.
 *
 * A stalled mailbox is usually a Google-side setup gap, and it presents as a
 * silent empty inbox. Surfaced in system settings and on /healthz. Not
 * persisted: it describes the running process.
 */

let lastError: string | null = null
let lastOkAt: number | null = null
let consecutiveFailures = 0

export function recordSyncOk(): void {
  lastError = null
  lastOkAt = Date.now()
  consecutiveFailures = 0
}

export function recordSyncError(message: string): void {
  lastError = message
  consecutiveFailures += 1
}

export function lastSyncError(): string | null {
  return lastError
}

export interface SyncHealth {
  ok: boolean
  /** Seconds since the last successful sync, or null if there has not been one. */
  staleSeconds: number | null
  consecutiveFailures: number
  lastError: string | null
}

/**
 * What a monitor needs to decide whether anyone should be woken. Reported
 * rather than acted on: a liveness check failing on a transient Google error
 * would take the container down for no reason.
 */
export function syncHealth(): SyncHealth {
  return {
    ok: lastError === null,
    staleSeconds: lastOkAt === null ? null : Math.round((Date.now() - lastOkAt) / 1000),
    consecutiveFailures,
    lastError,
  }
}
