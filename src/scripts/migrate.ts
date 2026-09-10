import { migrate, backfillMessageState } from '../db/index.ts'
import { config } from '../config.ts'

migrate()
const seeded = backfillMessageState()
console.log(`Schema applied to ${config.databasePath}`)
if (seeded > 0) console.log(`Seeded per-member state for ${seeded} message(s)`)
