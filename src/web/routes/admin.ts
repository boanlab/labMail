import { db, listUnassigned, activeAliases } from '../../db/index.ts'
import { approve, deactivate, reject, listUsers, assignMessage, reconcileSendAs } from '../../core/users.ts'
import { validateLocalPart } from '../../core/auth.ts'
import {
  publicSettings, setSettings, syncIntervalSeconds, orgDomain, isGoogleConnected,
  SETTING_KEYS, type SettingKey,
} from '../../core/settings.ts'
import { t } from '../../core/i18n.ts'
import { HttpError, json, readJson, str, clientAddress } from '../http.ts'
import { audit, listAudit, auditFacets, auditSize } from '../../core/audit.ts'
import { requireAdmin, redirectUriFor } from '../session.ts'
import { lastSyncError } from '../../core/sync-status.ts'
import { provisionMember } from '../../google/provisioning.ts'
import { toClientMessage } from '../serialize.ts'
import type { Router } from '../router.ts'

export function registerAdminRoutes(router: Router): void {
  // ── Members ───────────────────────────────────────────────────────────────
  router.get('/api/admin/users', async ({ req, res }) => {
    requireAdmin(req)
    // Best effort: a member list that cannot reach Google is still worth
    // serving, it just keeps showing the warning until the next look.
    if (isGoogleConnected()) {
      try { await reconcileSendAs() }
      catch (err) { console.warn('[members] send-as reconcile failed:', (err as Error).message) }
    }
    json(res, 200, { users: listUsers() })
  })

  router.post('/api/admin/users/:id/:verb', async ({ req, res, params, locale }) => {
    const admin = requireAdmin(req)
    const id = Number(params.id)
    if (!Number.isInteger(id)) throw new HttpError(400, 'member.notFound')

    const actor = { actor: admin.alias ?? admin.username, actorId: admin.id, ip: clientAddress(req) }

    switch (params.verb) {
      case 'approve': {
        const result = await approve(id)
        audit({ ...actor, action: 'member.approve', target: result.alias,
                detail: { sendAsRegistered: !result.sendAsError } })
        json(res, 200, {
          alias: result.alias,
          sendAsError: result.sendAsError,
          note: result.sendAsError
            ? t(locale, 'sendAs.unavailable', { alias: result.alias })
            : undefined,
        })
        return
      }
      case 'reject':
        reject(id)
        audit({ ...actor, action: 'member.reject', target: String(id) })
        json(res, 200, { ok: true })
        return
      case 'deactivate':
        await deactivate(id)
        audit({ ...actor, action: 'member.deactivate', target: String(id) })
        json(res, 200, { ok: true })
        return
      default:
        throw new HttpError(404, 'error.notFound')
    }
  })

  router.get('/api/admin/unassigned', ({ req, res }) => {
    const admin = requireAdmin(req)
    json(res, 200, {
      messages: listUnassigned().map((m) => toClientMessage(m, admin.alias ?? '')),
      aliases: activeAliases(),
    })
  })

  router.post('/api/admin/assign', async ({ req, res }) => {
    const admin = requireAdmin(req)
    const body = await readJson(req)
    const gmailId = str(body, 'gmailId')
    const alias = str(body, 'alias')
    assignMessage(gmailId, alias)
    // An administrator deciding whose mail this is: the single action that
    // hands one member's view of a message to somebody else.
    audit({
      actor: admin.alias ?? admin.username, actorId: admin.id,
      action: 'member.assign', target: gmailId, detail: { alias },
      ip: clientAddress(req),
    })
    json(res, 200, { ok: true })
  })

  /**
   * The audit log. Admin only, and reading it is itself recorded — an operator
   * looking through who read what is exactly the kind of access this table
   * exists to keep honest.
   */
  router.get('/api/admin/audit', ({ req, res, url }) => {
    const admin = requireAdmin(req)
    const actor = url.searchParams.get('actor') ?? undefined
    const action = url.searchParams.get('action') ?? undefined
    const since = url.searchParams.get('since') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? 100) || 100
    const offset = Number(url.searchParams.get('offset') ?? 0) || 0

    const page = listAudit({ actor, action, since, limit, offset })
    audit({
      actor: admin.alias ?? admin.username, actorId: admin.id,
      action: 'audit.view', detail: { actor, action, since }, ip: clientAddress(req),
    })
    json(res, 200, { ...page, ...auditFacets(), total: auditSize() })
  })

  // ── System settings ───────────────────────────────────────────────────────
  router.get('/api/admin/settings', ({ req, res }) => {
    requireAdmin(req)
    const lastSynced = db.prepare(`SELECT last_synced_at FROM sync_state WHERE id = 1`)
      .get() as { last_synced_at: string | null } | undefined
    json(res, 200, {
      settings: publicSettings(),
      redirectUri: redirectUriFor(req),
      syncIntervalSeconds: syncIntervalSeconds(),
      messageCount: (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n,
      lastSyncedAt: lastSynced?.last_synced_at ?? null,
      lastSyncError: lastSyncError(),
    })
  })

  router.post('/api/admin/settings', async ({ req, res }) => {
    const admin = requireAdmin(req)
    const body = await readJson(req)
    const updates: Partial<Record<SettingKey, string>> = {}
    for (const key of SETTING_KEYS) {
      const value = body[key]
      // Blank means "leave unchanged"; a secret field submits empty when untouched.
      if (typeof value === 'string' && value.trim()) updates[key] = value
    }
    if (updates.org_domain) {
      updates.org_domain = updates.org_domain.trim().toLowerCase().replace(/^@/, '')
    }
    setSettings(updates)
    // Keys only. Values include the OAuth secret, which must not be copied here.
    audit({
      actor: admin.alias ?? admin.username, actorId: admin.id,
      action: 'settings.save', detail: { keys: Object.keys(updates) },
      ip: clientAddress(req),
    })
    json(res, 200, { settings: publicSettings() })
  })

  /** Assign the operator account a mailbox, once the domain is known. */
  router.post('/api/admin/self-alias', async ({ req, res }) => {
    const admin = requireAdmin(req)
    const body = await readJson(req)
    const localPart = str(body, 'localPart').trim().toLowerCase()

    const invalid = validateLocalPart(localPart)
    if (invalid) throw new HttpError(400, invalid)

    const alias = `${localPart}@${orgDomain()}`
    const taken = db.prepare(`SELECT 1 FROM users WHERE alias_email = ? AND id != ?`)
      .get(alias, admin.id)
    if (taken) throw new HttpError(400, 'address.taken')

    // Provision before recording it: writing the address first would leave an
    // operator holding one that nothing delivers to.
    let sendAsError: string | undefined
    if (isGoogleConnected()) {
      try {
        const result = await provisionMember(alias, admin.displayName ?? localPart)
        sendAsError = result.sendAsError
      } catch (err) {
        throw new HttpError(502, 'member.provisionFailed', {
          reason: String((err as Error).message ?? err),
        })
      }
    }

    db.prepare(`UPDATE users SET alias_email = ? WHERE id = ?`).run(alias, admin.id)
    audit({
      actor: admin.alias ?? admin.username, actorId: admin.id,
      action: 'account.alias', target: alias, ip: clientAddress(req),
    })
    json(res, 200, { alias, sendAsError })
  })
}
