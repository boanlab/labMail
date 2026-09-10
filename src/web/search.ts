import { db, type MessageRow } from '../db/index.ts'

/**
 * Search one member's mail.
 *
 * Runs against the local mirror, scoped by the same `message_owners` join as
 * every other read. The term is bound as a parameter with LIKE wildcards
 * escaped, so `%` cannot widen the scope. Trash and Spam are excluded, matching
 * the convention every mail client follows, and so is anything the member has
 * deleted from their own view.
 */
export function searchMailbox(alias: string, query: string, limit = 50): MessageRow[] {
  const term = query.trim()
  if (!term) return []

  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`)
  const pattern = `%${escaped}%`

  return db.prepare(`
    SELECT m.* FROM messages m
    JOIN message_owners o ON o.message_id = m.id
    LEFT JOIN message_state st ON st.message_id = m.id AND st.alias = o.alias
    WHERE o.alias = ?
      AND COALESCE(st.is_removed, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value IN ('TRASH', 'SPAM'))
      AND (
        m.subject   LIKE ? ESCAPE '\\' OR
        m.from_addr LIKE ? ESCAPE '\\' OR
        m.from_name LIKE ? ESCAPE '\\' OR
        m.snippet   LIKE ? ESCAPE '\\' OR
        m.body_text LIKE ? ESCAPE '\\'
      )
    ORDER BY m.internal_date DESC
    LIMIT ?
  `).all(alias, pattern, pattern, pattern, pattern, pattern, Math.min(limit, 200)) as MessageRow[]
}
