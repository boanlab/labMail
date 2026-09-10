import { UserError } from './errors.ts'

/**
 * Failed-attempt throttling for sign-in, held in memory.
 *
 * Two independent buckets: one per account name, one per client address.
 * Either being locked refuses the attempt.
 */

/**
 * Two policies.
 *
 * An address is throttled hard: locking it costs a legitimate user nothing
 * unless they share it. An account is throttled loosely, because that lockout
 * can be aimed at a known user on purpose; it catches slow guessing spread
 * across addresses, which the address bucket cannot see.
 */
const POLICY = {
  ip: { free: 5, base: 30_000, max: 15 * 60_000 },
  user: { free: 20, base: 60_000, max: 15 * 60_000 },
} as const

const DEFAULT_POLICY = POLICY.ip
const policyFor = (key: string) =>
  key.startsWith('user:') ? POLICY.user : key.startsWith('ip:') ? POLICY.ip : DEFAULT_POLICY

/** Failures older than this stop counting. */
const WINDOW_MS = 15 * 60_000

interface Bucket { failures: number; lastFailure: number; lockedUntil: number }

const buckets = new Map<string, Bucket>()

function bucketFor(key: string): Bucket {
  const now = Date.now()
  const existing = buckets.get(key)
  if (existing && now - existing.lastFailure < WINDOW_MS) return existing
  const fresh: Bucket = { failures: 0, lastFailure: now, lockedUntil: 0 }
  buckets.set(key, fresh)
  return fresh
}

/** Seconds still to wait, or 0 when the key is free to try. */
export function lockedFor(key: string): number {
  const bucket = buckets.get(key)
  if (!bucket) return 0
  const remaining = bucket.lockedUntil - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

export function recordFailure(key: string): void {
  const { free, base, max } = policyFor(key)
  const bucket = bucketFor(key)
  bucket.failures += 1
  bucket.lastFailure = Date.now()
  if (bucket.failures > free) {
    const over = bucket.failures - free
    bucket.lockedUntil = Date.now() + Math.min(base * 2 ** (over - 1), max)
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key)
}

/** Refuse the attempt when any key is locked. The error names the wait. */
export function guard(keys: string[]): void {
  const waits = keys.map(lockedFor).filter((s) => s > 0)
  if (waits.length === 0) return
  throw Object.assign(new UserError('auth.throttled', { seconds: Math.max(...waits) }), {
    status: 429,
  })
}

/** Dropped once cold, so the table cannot grow without bound. */
export function sweepThrottles(): void {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastFailure > WINDOW_MS && bucket.lockedUntil < now) buckets.delete(key)
  }
}

export function throttleSize(): number {
  return buckets.size
}
