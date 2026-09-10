import { db } from '../db/index.ts'

export interface Contact {
  email: string
  name: string | null
  /** How often this address appears in the member's own mail. */
  uses: number
}

/**
 * Address suggestions for the composer.
 *
 * Drawn only from mail this alias owns, through the same `message_owners` join
 * as every other read: a suggestion list assembled from the shared mailbox at
 * large would leak who other members correspond with.
 */
const suggestQuery = db.prepare(`
  WITH mine AS (
    SELECT m.from_addr, m.from_name, m.to_addrs, m.cc_addrs, m.internal_date
    FROM messages m
    JOIN message_owners o ON o.message_id = m.id
    WHERE o.alias = ?
  ),
  addresses AS (
    SELECT lower(from_addr) AS email, from_name AS name, internal_date FROM mine
      WHERE from_addr <> ''
    UNION ALL
    SELECT lower(value), NULL, internal_date FROM mine, json_each(mine.to_addrs)
      WHERE value <> ''
    UNION ALL
    SELECT lower(value), NULL, internal_date FROM mine, json_each(mine.cc_addrs)
      WHERE value <> ''
  )
  SELECT email,
         MAX(name) AS name,
         COUNT(*)  AS uses,
         MAX(internal_date) AS last_seen
  FROM addresses
  WHERE email <> ?
    AND (email LIKE ? ESCAPE '\\' OR COALESCE(name, '') LIKE ? ESCAPE '\\')
  GROUP BY email
  ORDER BY uses DESC, last_seen DESC
  LIMIT ?
`)

/** Members of the organization, so a new correspondent is still suggestable. */
const memberQuery = db.prepare(`
  SELECT alias_email AS email, display_name AS name
  FROM users
  WHERE status = 'active' AND alias_email IS NOT NULL AND alias_email <> ?
    AND (alias_email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
  LIMIT ?
`)

export function suggestContacts(alias: string, query: string, limit = 8): Contact[] {
  const term = query.trim().toLowerCase()
  // LIKE wildcards in the term are escaped so a lone `%` cannot list everything.
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const capped = Math.min(Math.max(limit, 1), 20)

  const members = memberQuery.all(alias, pattern, pattern, capped) as
    { email: string; name: string | null }[]
  const seen = new Map<string, Contact>()
  for (const m of members) seen.set(m.email, { email: m.email, name: m.name, uses: 0 })

  const correspondents = suggestQuery.all(alias, alias, pattern, pattern, capped) as
    { email: string; name: string | null; uses: number }[]
  for (const c of correspondents) {
    const existing = seen.get(c.email)
    if (existing) existing.uses = c.uses
    else seen.set(c.email, { email: c.email, name: c.name, uses: c.uses })
  }

  return [...seen.values()]
    .sort((a, b) => b.uses - a.uses || a.email.localeCompare(b.email))
    .slice(0, capped)
}
