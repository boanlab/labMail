/**
 * In-process fan-out for live updates.
 *
 * Sync runs inside the web process, so a member's browser can be told the
 * moment their mail lands rather than finding out on the next poll. Listeners
 * are per-alias: a connection only ever hears about its own mailbox, which
 * keeps the isolation boundary the same one every read uses.
 */

export interface MailEvent {
  /** How many unread messages appeared since the last tick. */
  count: number
}

type Listener = (event: MailEvent) => void

const listeners = new Map<string, Set<Listener>>()

/** Returns the unsubscribe function; callers must invoke it when they close. */
export function subscribe(alias: string, listener: Listener): () => void {
  const key = alias.toLowerCase()
  let set = listeners.get(key)
  if (!set) { set = new Set(); listeners.set(key, set) }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(key)
  }
}

export function emitNewMail(alias: string, count: number): void {
  const set = listeners.get(alias.toLowerCase())
  if (!set) return
  for (const listener of set) {
    // One broken connection must not stop the others from being told.
    try { listener({ count }) } catch { /* dropped on the next write */ }
  }
}

export function listenerCount(): number {
  let total = 0
  for (const set of listeners.values()) total += set.size
  return total
}
