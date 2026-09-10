import {
  listMailbox, getMessageForAlias, getThreadForAlias, mailboxCounts,
  type Mailbox, type MailboxFilter, emptyTrashFor } from '../../db/index.ts'
import { sendAs, applyAction, fetchAttachment } from '../../google/actions.ts'
import { saveDraft, sendDraft, discardDraft } from '../../google/drafts.ts'
import { cancel as cancelHeldSend } from '../../google/outbox.ts'
import { undoSendSeconds } from '../../core/settings.ts'
import { InvalidAddressError } from '../../google/mime.ts'
import { isValidAddress } from '../../google/addresses.ts'
import { incrementalSync, fullSync, currentHistoryId, reresolveUnassigned, linkDrafts } from '../../google/sync.ts'
import { recordSyncOk, recordSyncError } from '../../core/sync-status.ts'
import { subscribe } from '../../core/events.ts'
import { isGoogleConnected } from '../../core/settings.ts'
import { HttpError, json, readJson, str, strArray, clientAddress } from '../http.ts'
import { requireMailbox, requireSender, requireUser } from '../session.ts'
import { audit } from '../../core/audit.ts'
import { toClientMessage } from '../serialize.ts'
import { searchMailbox } from '../search.ts'
import { suggestContacts } from '../contacts.ts'
import type { Router } from '../router.ts'

const MAILBOXES: Mailbox[] = ['inbox', 'sent', 'trash', 'spam', 'drafts', 'archive', 'category']
const FILTERS: MailboxFilter[] = ['all', 'unread', 'starred']
const MAX_BULK = 100

export function registerMailRoutes(router: Router): void {
  /** Address suggestions, scoped to the caller's own correspondence. */
  router.get('/api/contacts', ({ req, res, url }) => {
    const user = requireMailbox(req)
    const query = url.searchParams.get('q') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? 8)
    json(res, 200, { contacts: suggestContacts(user.alias, query, limit) })
  })

  router.get('/api/messages', ({ req, res, url }) => {
    const user = requireMailbox(req)
    const query = url.searchParams.get('q')?.trim()
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200)
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

    if (query) {
      json(res, 200, {
        messages: searchMailbox(user.alias, query, limit).map((m) => toClientMessage(m, user.alias)),
        hasMore: false,
        counts: mailboxCounts(user.alias),
      })
      return
    }

    const mailbox = url.searchParams.get('mailbox') ?? 'inbox'
    const filter = url.searchParams.get('filter') ?? 'all'
    // Whitelisted: both names select a SQL predicate.
    if (!MAILBOXES.includes(mailbox as Mailbox)) throw new HttpError(400, 'mailbox.unknown')
    if (!FILTERS.includes(filter as MailboxFilter)) throw new HttpError(400, 'mailbox.unknownFilter')

    // A category is a view across the mailbox, so it arrives as its own name
    // with the id alongside rather than as a sixth mailbox.
    const categoryId = Number(url.searchParams.get('categoryId') ?? 0) || undefined
    if (mailbox === 'category' && !categoryId) throw new HttpError(400, 'category.notFound')

    // One extra row signals a further page without a second COUNT query.
    const rows = listMailbox(user.alias, mailbox as Mailbox, {
      limit: limit + 1, offset, filter: filter as MailboxFilter, categoryId,
    })
    json(res, 200, {
      messages: rows.slice(0, limit).map((m) => toClientMessage(m, user.alias)),
      hasMore: rows.length > limit,
      counts: mailboxCounts(user.alias),
    })
  })

  router.get('/api/messages/:id', ({ req, res, params }) => {
    const user = requireMailbox(req)
    const row = getMessageForAlias(user.alias, params.id!)
    if (!row) throw new HttpError(404, 'mailbox.messageNotFound')

    // Opening one message, not listing a mailbox: this is the access someone
    // may later need answered for, and the only one worth the row.
    audit({
      actor: user.alias, actorId: user.id, action: 'message.read',
      target: row.gmail_id, ip: clientAddress(req),
    })
    json(res, 200, {
      message: toClientMessage(row, user.alias, true),
      // Bodies included so the conversation view expands without a round trip.
      thread: getThreadForAlias(user.alias, row.gmail_thread_id)
        .map((m) => toClientMessage(m, user.alias, true)),
    })
  })

  /**
   * Empty the Trash, for this member only.
   *
   * Registered before the /:id routes so the literal path is not read as a
   * message id.
   */
  router.post('/api/messages/empty-trash', ({ req, res }) => {
    const user = requireMailbox(req)
    const removed = emptyTrashFor(user.alias)
    audit({
      actor: user.alias, actorId: user.id, action: 'message.action',
      detail: { verb: 'empty-trash', removed }, ip: clientAddress(req),
    })
    json(res, 200, { removed })
  })

  router.post('/api/messages/:id/action', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    const action = str(body, 'action')
    const labels = await applyAction(user.alias, params.id!, action)
    // Only what changes the shared mailbox. Read, star and archive are this
    // member's own view and would bury the log without recording a decision.
    if (['trash', 'untrash', 'spam', 'notspam'].includes(action)) {
      audit({
        actor: user.alias, actorId: user.id, action: 'message.action',
        target: params.id!, detail: { verb: action }, ip: clientAddress(req),
      })
    }
    json(res, 200, { labels })
  })

  router.post('/api/messages/bulk', async ({ req, res }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    const ids = strArray(body, 'ids').slice(0, MAX_BULK)
    const action = str(body, 'action')
    if (ids.length === 0) throw new HttpError(400, 'mailbox.noSelection')

    // One at a time so each keeps its ownership check.
    const failed: string[] = []
    for (const id of ids) {
      try {
        await applyAction(user.alias, id, action)
      } catch (err) {
        // Logged: the client summary alone is not diagnosable.
        console.warn(`[bulk] ${action} failed for ${id}:`, (err as Error).message)
        failed.push(id)
      }
    }
    json(res, 200, { applied: ids.length - failed.length, failed })
  })

  router.get('/api/messages/:id/attachments/:attachmentId', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const att = await fetchAttachment(user.alias, params.id!, params.attachmentId!)
    res.writeHead(200, {
      'content-type': att.mimeType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'content-length': att.content.length,
    })
    res.end(att.content)
  })

  router.post('/api/send', async ({ req, res }) => {
    const user = requireSender(req)
    const body = await readJson(req)
    const to = strArray(body, 'to')
    const cc = strArray(body, 'cc')
    const bcc = strArray(body, 'bcc')
    if (to.length === 0) throw new HttpError(400, 'mailbox.noRecipient')

    // Validated before anything reaches Google, so malformed input is a 400
    // rather than a configuration complaint or a failed API call.
    for (const address of [...to, ...cc, ...bcc]) {
      if (!isValidAddress(address)) {
        throw new HttpError(400, 'mailbox.invalidAddress', { address })
      }
    }

    const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
      .map((a: Record<string, unknown>) => ({
        filename: String(a.filename ?? 'attachment'),
        mimeType: String(a.mimeType || 'application/octet-stream'),
        content: Buffer.from(String(a.contentBase64 ?? ''), 'base64'),
      }))

    let result
    try {
      result = await sendAs(
        { alias: user.alias, displayName: user.displayName },
        {
          to,
          cc,
          bcc,
          subject: str(body, 'subject'),
          bodyText: str(body, 'bodyText'),
          bodyHtml: str(body, 'bodyHtml') || undefined,
          replyToMessageId: str(body, 'replyToMessageId') || undefined,
          attachments,
        },
        // Held only when the deployment allows a window and the caller wants it.
        { hold: undoSendSeconds() > 0 && body.immediate !== true },
      )
    } catch (err) {
      if (err instanceof InvalidAddressError) {
        throw new HttpError(400, 'mailbox.invalidAddress', { address: err.address })
      }
      throw err
    }
    // Recipient counts rather than addresses: the log records that a member
    // sent mail as themselves, which is the claim that might be disputed, and
    // is not a place to accumulate a second copy of who they correspond with.
    audit({
      actor: user.alias, actorId: user.id, action: 'message.send',
      target: result.gmailId ?? result.pendingId ?? null,
      detail: { to: to.length, cc: cc.length, bcc: bcc.length, attachments: attachments.length },
      ip: clientAddress(req),
    })
    json(res, 200, result)
  })

  /** Create or update a draft. Omit `draftId` to create. */
  router.post('/api/drafts', async ({ req, res }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    const to = strArray(body, 'to')
    const cc = strArray(body, 'cc')
    const bcc = strArray(body, 'bcc')

    // A draft may legitimately have no recipient yet, but any address present
    // is validated now rather than at send time.
    for (const address of [...to, ...cc, ...bcc]) {
      if (!isValidAddress(address)) {
        throw new HttpError(400, 'mailbox.invalidAddress', { address })
      }
    }

    const result = await saveDraft(
      { alias: user.alias, displayName: user.displayName },
      {
        to,
        cc,
        bcc,
        subject: str(body, 'subject'),
        bodyText: str(body, 'bodyText'),
        bodyHtml: str(body, 'bodyHtml') || undefined,
        replyToMessageId: str(body, 'replyToMessageId') || undefined,
      },
      str(body, 'draftId') || undefined,
    )
    json(res, 200, result)
  })

  router.post('/api/drafts/:draftId/send', async ({ req, res, params }) => {
    const user = requireSender(req)
    json(res, 200, await sendDraft(user.alias, params.draftId!))
  })

  router.post('/api/drafts/:draftId/discard', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    await discardDraft(user.alias, params.draftId!)
    json(res, 200, { ok: true })
  })

  /** Recall a message still inside its undo window. */
  router.post('/api/send/:pendingId/cancel', ({ req, res, params }) => {
    const user = requireMailbox(req)
    const recalled = cancelHeldSend(user.alias, params.pendingId!)
    if (!recalled) throw new HttpError(409, 'mailbox.undoExpired')
    json(res, 200, { ok: true })
  })

  /**
   * Live updates for the signed-in mailbox.
   *
   * Server-sent events rather than polling: sync already runs in this process,
   * so the moment it attributes mail to this alias the browser can be told.
   * The stream carries a count, never content — the client re-reads through
   * the ordinary, ownership-checked endpoints.
   */
  router.get('/api/events', ({ req, res }) => {
    const user = requireMailbox(req)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming.
      'x-accel-buffering': 'no',
    })
    res.write('retry: 5000\n\n')

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const unsubscribe = subscribe(user.alias, (payload) => send('mail', payload))

    // Comment frames keep intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
    const close = () => { clearInterval(heartbeat); unsubscribe() }
    req.on('close', close)
    req.on('error', close)
  })

  router.post('/api/sync', async ({ req, res }) => {
    requireUser(req)
    if (!isGoogleConnected()) throw new HttpError(409, 'setup.syncUnavailable')
    try {
      const result = currentHistoryId()
        ? await incrementalSync()
        : { changed: await fullSync(), fellBack: true }
      reresolveUnassigned()
      await linkDrafts()
      recordSyncOk()
      json(res, 200, result)
    } catch (err) {
      // Recorded as well as thrown: the caller sees it once, system settings
      // keeps showing it until a sync succeeds.
      recordSyncError((err as Error).message)
      throw err
    }
  })
}
