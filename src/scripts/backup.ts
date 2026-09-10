import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { db } from '../db/index.ts'
import { config } from '../config.ts'

/**
 * Consistent backup of the one file that matters.
 *
 *   npm run backup -- /backups            take one
 *   npm run backup -- /backups --verify   take one and prove it opens
 *   npm run backup -- /backups --keep 14  prune older archives
 *
 * SQLite's own backup API rather than `cp`: the database runs in WAL mode, so a
 * file copy taken mid-write yields a torn snapshot that only fails later, when
 * it is needed. This copies through the engine and then checks the result.
 */

const args = process.argv.slice(2)
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? './backups')
const verify = args.includes('--verify')
const keepIndex = args.indexOf('--keep')
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 0

mkdirSync(dir, { recursive: true })

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const raw = join(dir, `labmail-${timestamp}.db`)
const archive = `${raw}.gz`

await db.backup(raw)

/** Opening the copy is the only proof that it is usable. */
function inspect(path: string): { messages: number; users: number; integrity: string } {
  const copy = new Database(path, { readonly: true })
  try {
    const integrity = (copy.pragma('integrity_check', { simple: true }) as string) ?? 'unknown'
    const messages = (copy.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n
    const users = (copy.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n
    return { messages, users, integrity }
  } finally { copy.close() }
}

const report = inspect(raw)
if (report.integrity !== 'ok') {
  unlinkSync(raw)
  console.error(`Backup failed its integrity check (${report.integrity}); the copy was discarded.`)
  process.exit(1)
}

await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(archive))
unlinkSync(raw)

const size = statSync(archive).size
console.log(`Backed up ${config.databasePath}`)
console.log(`  → ${archive}  (${(size / 1048576).toFixed(1)} MB)`)
console.log(`  ${report.messages} messages, ${report.users} accounts, integrity ${report.integrity}`)

// A backup nobody has restored is a guess. --verify decompresses the archive
// that was just written and opens that, so the whole round trip is exercised.
if (verify) {
  const { createGunzip } = await import('node:zlib')
  const probe = join(dir, `.verify-${timestamp}.db`)
  await pipeline(createReadStream(archive), createGunzip(), createWriteStream(probe))
  const restored = inspect(probe)
  unlinkSync(probe)
  const same = restored.messages === report.messages && restored.users === report.users
  console.log(`  verify: integrity ${restored.integrity}, `
    + `${restored.messages} messages, ${restored.users} accounts`)
  if (restored.integrity !== 'ok' || !same) {
    console.error('  the restored copy does not match the source')
    process.exit(1)
  }
  console.log('  verify: restored copy matches')
}

if (keep > 0) {
  const archives = readdirSync(dir)
    .filter((f) => f.startsWith('labmail-') && f.endsWith('.db.gz'))
    .sort()
  const stale = archives.slice(0, Math.max(0, archives.length - keep))
  for (const file of stale) unlinkSync(join(dir, file))
  if (stale.length > 0) console.log(`  pruned ${stale.length} older archive(s), keeping ${keep}`)
}
