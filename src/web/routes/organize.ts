import {
  listCategories, createCategory, renameCategory, deleteCategory, setMessageCategory,
} from '../../core/categories.ts'
import {
  listRules, createRule, updateRule, deleteRule, setRuleEnabled, applyRulesToExisting,
  RULE_FIELDS, RULE_OPS,
} from '../../core/rules.ts'
import { HttpError, json, readJson, str } from '../http.ts'
import { requireMailbox } from '../session.ts'
import type { Router } from '../router.ts'

const id = (value: string | undefined): number => {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'error.notFound')
  return n
}

/**
 * Categories and rules: a member organising their own view.
 *
 * Every handler scopes on `user.alias` from the session, and the core modules
 * check ownership again in the statement itself, so an id from the request
 * reaches nothing that is not the caller's.
 */
export function registerOrganizeRoutes(router: Router): void {
  router.get('/api/categories', ({ req, res }) => {
    const user = requireMailbox(req)
    json(res, 200, { categories: listCategories(user.alias) })
  })

  router.post('/api/categories', async ({ req, res }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    json(res, 201, {
      category: createCategory(user.alias, str(body, 'name'), str(body, 'color') || undefined),
    })
  })

  router.post('/api/categories/:id', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    renameCategory(user.alias, id(params.id), str(body, 'name'), str(body, 'color') || undefined)
    json(res, 200, { categories: listCategories(user.alias) })
  })

  router.post('/api/categories/:id/delete', ({ req, res, params }) => {
    const user = requireMailbox(req)
    deleteCategory(user.alias, id(params.id))
    json(res, 200, { categories: listCategories(user.alias) })
  })

  /** Attach or detach a category on one message. */
  router.post('/api/messages/:id/categories', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    const categoryId = Number((body as Record<string, unknown>).categoryId)
    if (!Number.isInteger(categoryId)) throw new HttpError(400, 'category.notFound')
    setMessageCategory(user.alias, params.id!, categoryId, (body as Record<string, unknown>).on === true)
    json(res, 200, { ok: true })
  })

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get('/api/rules', ({ req, res }) => {
    const user = requireMailbox(req)
    json(res, 200, { rules: listRules(user.alias), fields: RULE_FIELDS, operators: RULE_OPS })
  })

  router.post('/api/rules', async ({ req, res }) => {
    const user = requireMailbox(req)
    const body = await readJson(req) as Record<string, unknown>
    json(res, 201, {
      rule: createRule(user.alias, {
        name: String(body.name ?? ''),
        matchType: String(body.matchType ?? 'all'),
        conditions: body.conditions,
        actions: body.actions,
      }),
    })
  })

  /** Replay the rules over mail that arrived before they existed. */
  router.post('/api/rules/apply', ({ req, res }) => {
    const user = requireMailbox(req)
    json(res, 200, applyRulesToExisting(user.alias))
  })

  router.post('/api/rules/:id', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const body = await readJson(req) as Record<string, unknown>
    updateRule(user.alias, id(params.id), {
      name: String(body.name ?? ''),
      matchType: String(body.matchType ?? 'all'),
      conditions: body.conditions,
      actions: body.actions,
      enabled: body.enabled !== false,
    })
    json(res, 200, { rules: listRules(user.alias) })
  })

  router.post('/api/rules/:id/enabled', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const body = await readJson(req) as Record<string, unknown>
    setRuleEnabled(user.alias, id(params.id), body.enabled === true)
    json(res, 200, { rules: listRules(user.alias) })
  })

  router.post('/api/rules/:id/delete', ({ req, res, params }) => {
    const user = requireMailbox(req)
    deleteRule(user.alias, id(params.id))
    json(res, 200, { rules: listRules(user.alias) })
  })

}
