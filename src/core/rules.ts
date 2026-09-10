import { db, setMessageState, type MessageRow } from '../db/index.ts'
import { attachCategory } from './categories.ts'
import { UserError } from './errors.ts'

/**
 * Member-defined rules.
 *
 * Every action writes only per-member tables — state and categories — so a rule
 * one member writes can never move, hide or mark another member's mail, even
 * when both own the same message.
 */

export const RULE_FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'recipient'] as const
export const RULE_OPS = ['contains', 'equals', 'startsWith', 'endsWith', 'notContains'] as const

export type RuleField = (typeof RULE_FIELDS)[number]
export type RuleOp = (typeof RULE_OPS)[number]

export interface RuleCondition { field: RuleField; op: RuleOp; value: string }

export interface RuleActions {
  categoryId?: number | null
  read?: boolean
  star?: boolean
  archive?: boolean
}

export interface Rule {
  id: number
  name: string
  enabled: boolean
  position: number
  matchType: 'all' | 'any'
  conditions: RuleCondition[]
  actions: RuleActions
}

const MAX_RULES = 100
const MAX_CONDITIONS = 10

interface RuleRow {
  id: number; name: string; enabled: number; position: number
  match_type: 'all' | 'any'; conditions: string; actions: string
}

const toRule = (row: RuleRow): Rule => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled === 1,
  position: row.position,
  matchType: row.match_type,
  conditions: JSON.parse(row.conditions) as RuleCondition[],
  actions: JSON.parse(row.actions) as RuleActions,
})

export function listRules(alias: string): Rule[] {
  return (db.prepare(
    `SELECT * FROM rules WHERE alias = ? ORDER BY position, id`,
  ).all(alias) as RuleRow[]).map(toRule)
}

/** Validation is the boundary: everything below assumes these shapes hold. */
function validate(input: {
  name: string; matchType: string; conditions: unknown; actions: unknown
}, alias: string): {
  name: string; matchType: 'all' | 'any'; conditions: RuleCondition[]; actions: RuleActions
} {
  const name = input.name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 60)
  if (!name) throw new UserError('rule.nameRequired')

  const matchType = input.matchType === 'any' ? 'any' : 'all'

  const raw = Array.isArray(input.conditions) ? input.conditions : []
  if (raw.length === 0) throw new UserError('rule.needCondition')
  if (raw.length > MAX_CONDITIONS) throw new UserError('rule.tooManyConditions')

  const conditions: RuleCondition[] = raw.map((c) => {
    const cond = c as Partial<RuleCondition>
    if (!RULE_FIELDS.includes(cond.field as RuleField)) throw new UserError('rule.badField')
    if (!RULE_OPS.includes(cond.op as RuleOp)) throw new UserError('rule.badOperator')
    const value = String(cond.value ?? '').trim()
    if (!value) throw new UserError('rule.needValue')
    return { field: cond.field as RuleField, op: cond.op as RuleOp, value: value.slice(0, 200) }
  })

  const a = (input.actions ?? {}) as RuleActions
  const actions: RuleActions = {
    read: a.read === true,
    star: a.star === true,
    archive: a.archive === true,
    categoryId: null,
  }
  if (a.categoryId != null) {
    const owned = db.prepare(`SELECT 1 FROM categories WHERE id = ? AND alias = ?`)
      .get(a.categoryId, alias)
    if (!owned) throw new UserError('category.notFound')
    actions.categoryId = Number(a.categoryId)
  }
  if (!actions.read && !actions.star && !actions.archive && actions.categoryId == null) {
    throw new UserError('rule.needAction')
  }
  return { name, matchType, conditions, actions }
}

export function createRule(alias: string, input: {
  name: string; matchType: string; conditions: unknown; actions: unknown
}): Rule {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM rules WHERE alias = ?`)
    .get(alias) as { n: number }
  if (count.n >= MAX_RULES) throw new UserError('rule.tooMany')

  const v = validate(input, alias)
  const info = db.prepare(`
    INSERT INTO rules (alias, name, match_type, conditions, actions, position)
    VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM rules WHERE alias = ?))
  `).run(alias, v.name, v.matchType, JSON.stringify(v.conditions), JSON.stringify(v.actions), alias)
  return listRules(alias).find((r) => r.id === Number(info.lastInsertRowid))!
}

export function updateRule(alias: string, id: number, input: {
  name: string; matchType: string; conditions: unknown; actions: unknown; enabled?: boolean
}): void {
  const v = validate(input, alias)
  const info = db.prepare(`
    UPDATE rules SET name = ?, match_type = ?, conditions = ?, actions = ?, enabled = ?
    WHERE id = ? AND alias = ?
  `).run(v.name, v.matchType, JSON.stringify(v.conditions), JSON.stringify(v.actions),
         input.enabled === false ? 0 : 1, id, alias)
  if (info.changes === 0) throw new UserError('rule.notFound')
}

export function deleteRule(alias: string, id: number): void {
  const info = db.prepare(`DELETE FROM rules WHERE id = ? AND alias = ?`).run(id, alias)
  if (info.changes === 0) throw new UserError('rule.notFound')
}

export function setRuleEnabled(alias: string, id: number, enabled: boolean): void {
  const info = db.prepare(`UPDATE rules SET enabled = ? WHERE id = ? AND alias = ?`)
    .run(enabled ? 1 : 0, id, alias)
  if (info.changes === 0) throw new UserError('rule.notFound')
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** The haystack a condition looks in, lowercased once per message. */
function haystack(row: MessageRow, field: RuleField): string {
  switch (field) {
    case 'from': return `${row.from_name ?? ''} ${row.from_addr}`.toLowerCase()
    case 'to': return (row.to_addrs || '[]').toLowerCase()
    case 'cc': return (row.cc_addrs || '[]').toLowerCase()
    case 'subject': return (row.subject || '').toLowerCase()
    case 'body': return `${row.body_text ?? ''} ${row.snippet ?? ''}`.toLowerCase()
    // Every address the message was delivered to, envelope included.
    case 'recipient': return `${row.to_addrs} ${row.cc_addrs} ${row.routing_headers}`.toLowerCase()
  }
}

function matches(row: MessageRow, condition: RuleCondition): boolean {
  const text = haystack(row, condition.field)
  const value = condition.value.toLowerCase()
  switch (condition.op) {
    case 'contains': return text.includes(value)
    case 'notContains': return !text.includes(value)
    case 'equals': return text.trim() === value
    case 'startsWith': return text.trimStart().startsWith(value)
    case 'endsWith': return text.trimEnd().endsWith(value)
  }
}

function ruleMatches(row: MessageRow, rule: Rule): boolean {
  return rule.matchType === 'all'
    ? rule.conditions.every((c) => matches(row, c))
    : rule.conditions.some((c) => matches(row, c))
}

/**
 * Run one member's rules over one message.
 *
 * Every matching rule applies, in order — the last one to set a given flag
 * wins, and categories accumulate. Returns the rules that fired, which is what
 * lets the "apply now" endpoint report what it did.
 */
export function applyRules(alias: string, row: MessageRow, rules?: Rule[]): string[] {
  const active = (rules ?? listRules(alias)).filter((r) => r.enabled)
  const fired: string[] = []

  for (const rule of active) {
    if (!ruleMatches(row, rule)) continue
    fired.push(rule.name)
    if (rule.actions.categoryId != null) attachCategory(row.id, rule.actions.categoryId)
    if (rule.actions.read) setMessageState(row.id, alias, 'is_read', true)
    if (rule.actions.star) setMessageState(row.id, alias, 'is_starred', true)
    if (rule.actions.archive) setMessageState(row.id, alias, 'is_archived', true)
  }
  return fired
}

/**
 * Re-run the rules over mail that is already here.
 *
 * Rules normally fire once, when a message is first attributed. A member who
 * writes a rule expects it to tidy what is already in front of them, so this
 * replays them over everything they own.
 */
export function applyRulesToExisting(alias: string, limit = 2_000): { scanned: number; changed: number } {
  const rules = listRules(alias).filter((r) => r.enabled)
  if (rules.length === 0) return { scanned: 0, changed: 0 }

  const rows = db.prepare(`
    SELECT m.* FROM messages m
    JOIN message_owners o ON o.message_id = m.id
    WHERE o.alias = ?
      AND NOT EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value IN ('TRASH', 'SPAM', 'DRAFT'))
    ORDER BY m.internal_date DESC
    LIMIT ?
  `).all(alias, limit) as MessageRow[]

  let changed = 0
  db.transaction(() => {
    for (const row of rows) if (applyRules(alias, row, rules).length > 0) changed++
  })()
  return { scanned: rows.length, changed }
}
