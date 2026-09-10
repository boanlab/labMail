import { db } from '../db/index.ts'
import { UserError } from './errors.ts'

export interface Category {
  id: number
  name: string
  color: string | null
  position: number
  count: number
}

/** Reserved for the palette the client offers; anything else is refused. */
const COLORS = new Set([
  'slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink',
])

const MAX_NAME = 40
const MAX_PER_MEMBER = 50

function clean(name: string): string {
  const value = name.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NAME)
  if (!value) throw new UserError('category.nameRequired')
  return value
}

/**
 * A member's categories, with how much mail each holds.
 *
 * The count excludes trash and spam so the sidebar figure matches what opening
 * the category actually shows.
 */
export function listCategories(alias: string): Category[] {
  return db.prepare(`
    SELECT c.id, c.name, c.color, c.position,
           (SELECT COUNT(*)
              FROM message_categories mc
              JOIN messages m ON m.id = mc.message_id
              JOIN message_owners o ON o.message_id = m.id AND o.alias = c.alias
             WHERE mc.category_id = c.id
               AND NOT EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value IN ('TRASH', 'SPAM'))
           ) AS count
    FROM categories c
    WHERE c.alias = ?
    ORDER BY c.position, c.id
  `).all(alias) as Category[]
}

export function createCategory(alias: string, name: string, color?: string): Category {
  const value = clean(name)
  if (color && !COLORS.has(color)) throw new UserError('category.badColor')

  const existing = db.prepare(
    `SELECT COUNT(*) AS n FROM categories WHERE alias = ?`,
  ).get(alias) as { n: number }
  if (existing.n >= MAX_PER_MEMBER) throw new UserError('category.tooMany')

  try {
    const info = db.prepare(`
      INSERT INTO categories (alias, name, color, position)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM categories WHERE alias = ?))
    `).run(alias, value, color ?? null, alias)
    return listCategories(alias).find((c) => c.id === Number(info.lastInsertRowid))!
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) throw new UserError('category.duplicate')
    throw err
  }
}

/** Ownership check and update in one statement: a guessed id reaches nothing. */
export function renameCategory(alias: string, id: number, name: string, color?: string): void {
  const value = clean(name)
  if (color && !COLORS.has(color)) throw new UserError('category.badColor')
  const info = db.prepare(
    `UPDATE categories SET name = ?, color = COALESCE(?, color) WHERE id = ? AND alias = ?`,
  ).run(value, color ?? null, id, alias)
  if (info.changes === 0) throw new UserError('category.notFound')
}

export function deleteCategory(alias: string, id: number): void {
  const info = db.prepare(`DELETE FROM categories WHERE id = ? AND alias = ?`).run(id, alias)
  if (info.changes === 0) throw new UserError('category.notFound')
}

/**
 * Attach or detach a category, verifying both halves belong to this member.
 *
 * The message check is the same ownership join every read uses; the category
 * check is its alias column. Neither id is trusted from the request.
 */
export function setMessageCategory(
  alias: string, gmailId: string, categoryId: number, on: boolean,
): void {
  const message = db.prepare(`
    SELECT m.id FROM messages m
    JOIN message_owners o ON o.message_id = m.id
    WHERE o.alias = ? AND m.gmail_id = ?
  `).get(alias, gmailId) as { id: number } | undefined
  if (!message) throw new UserError('mailbox.messageNotFound')

  const owned = db.prepare(
    `SELECT 1 FROM categories WHERE id = ? AND alias = ?`,
  ).get(categoryId, alias)
  if (!owned) throw new UserError('category.notFound')

  if (on) {
    db.prepare(`
      INSERT INTO message_categories (message_id, category_id) VALUES (?, ?)
      ON CONFLICT (message_id, category_id) DO NOTHING
    `).run(message.id, categoryId)
  } else {
    db.prepare(
      `DELETE FROM message_categories WHERE message_id = ? AND category_id = ?`,
    ).run(message.id, categoryId)
  }
}

/** Used by the rules engine, which already holds an internal message id. */
export function attachCategory(messageId: number, categoryId: number): void {
  db.prepare(`
    INSERT INTO message_categories (message_id, category_id) VALUES (?, ?)
    ON CONFLICT (message_id, category_id) DO NOTHING
  `).run(messageId, categoryId)
}
