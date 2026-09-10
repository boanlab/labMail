/**
 * Sync runner. One pass by default, `--watch` to poll.
 *
 * The server runs the same functions on an interval; this is for backfills and
 * debugging.
 */
import { migrate } from '../db/index.ts'
import { fullSync, incrementalSync, currentHistoryId, reresolveUnassigned } from '../google/sync.ts'

const args = new Set(process.argv.slice(2))
const intervalSeconds = Number(
  process.argv.find((a) => a.startsWith('--interval='))?.split('=')[1] ?? 60,
)

migrate()

async function once(): Promise<void> {
  const started = Date.now()
  if (args.has('--full') || !currentHistoryId()) {
    const n = await fullSync()
    console.log(`[sync] full sync: ${n} messages in ${Date.now() - started}ms`)
  } else {
    const { changed, fellBack } = await incrementalSync()
    console.log(`[sync] ${fellBack ? 'recovered' : 'incremental'}: ${changed} changed in ${Date.now() - started}ms`)
  }
  const assigned = reresolveUnassigned()
  if (assigned > 0) console.log(`[sync] attributed ${assigned} previously unassigned messages`)
}

if (args.has('--watch')) {
  console.log(`[sync] polling every ${intervalSeconds}s — Ctrl+C to stop`)
  const tick = async () => {
    try { await once() } catch (err) { console.error('[sync] failed:', (err as Error).message) }
  }
  await tick()
  setInterval(tick, intervalSeconds * 1000)
} else {
  await once()
  process.exit(0)
}
