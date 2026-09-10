import { listDriveChildren } from '../../db/index.ts'
import {
  listFolder, pathTo, createFolder, uploadFile, renameItem, trashItem,
  downloadFile, shareableLink, usage, homeFolderOf, ensureHomeFolder,
} from '../../google/drive.ts'
import { HttpError, json, readJson, str } from '../http.ts'
import { requireMailbox } from '../session.ts'
import type { Router } from '../router.ts'

/** Upload cap. Larger than the mail body limit, since Drive is the way past it. */
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024

async function readBinary(req: Parameters<typeof readJson>[0]): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > UPLOAD_LIMIT_BYTES) throw new HttpError(413, 'drive.tooLarge')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const toClient = (row: {
  file_id: string; name: string; mime_type: string
  size_bytes: number; is_folder: number; modified_at: string | null
}) => ({
  id: row.file_id,
  name: row.name,
  mimeType: row.mime_type,
  size: row.size_bytes,
  isFolder: row.is_folder === 1,
  modifiedAt: row.modified_at,
})

/**
 * The member's home folder, created now if absent. Approval is not the only way
 * in: the bootstrap operator never goes through it.
 */
async function homeFolder(user: { id: number; alias: string }): Promise<string> {
  return homeFolderOf(user.alias) ?? await ensureHomeFolder(user.id, user.alias)
}

export function registerDriveRoutes(router: Router): void {
  router.get('/api/drive', async ({ req, res, url }) => {
    const user = requireMailbox(req)
    await homeFolder(user)

    const folderId = url.searchParams.get('folderId') ?? undefined
    const listing = await listFolder(user.alias, folderId)
    json(res, 200, {
      parentId: listing.parentId,
      isHome: listing.isHome,
      path: pathTo(user.alias, listing.parentId).map(toClient),
      items: listing.items.map(toClient),
    })
  })

  router.get('/api/drive/usage', async ({ req, res }) => {
    const user = requireMailbox(req)
    await homeFolder(user)
    json(res, 200, await usage(user.alias))
  })

  router.post('/api/drive/folder', async ({ req, res }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    const created = await createFolder(user.alias, str(body, 'name'), str(body, 'parentId') || undefined)
    json(res, 200, toClient(created))
  })

  /**
   * Raw body upload. Binary rather than base64 in JSON, which would inflate a
   * large file by a third.
   */
  router.post('/api/drive/upload', async ({ req, res, url }) => {
    const user = requireMailbox(req)
    const name = url.searchParams.get('name') ?? ''
    if (!name) throw new HttpError(400, 'drive.nameInvalid')

    const content = await readBinary(req)
    const created = await uploadFile(
      user.alias, name,
      req.headers['content-type'] ?? 'application/octet-stream',
      content,
      url.searchParams.get('parentId') ?? undefined,
    )
    json(res, 200, toClient(created))
  })

  router.post('/api/drive/:fileId/rename', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const body = await readJson(req)
    json(res, 200, toClient(await renameItem(user.alias, params.fileId!, str(body, 'name'))))
  })

  router.post('/api/drive/:fileId/trash', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    await trashItem(user.alias, params.fileId!)
    json(res, 200, { ok: true })
  })

  router.get('/api/drive/:fileId/download', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    const file = await downloadFile(user.alias, params.fileId!)
    res.writeHead(200, {
      'content-type': file.mimeType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'content-length': file.content.length,
    })
    res.end(file.content)
  })

  /** A link for attaching the file to outgoing mail. */
  router.post('/api/drive/:fileId/link', async ({ req, res, params }) => {
    const user = requireMailbox(req)
    json(res, 200, await shareableLink(user.alias, params.fileId!))
  })

  /** Cached listing, for the compose picker where a round trip would show. */
  router.get('/api/drive/cached', async ({ req, res, url }) => {
    const user = requireMailbox(req)
    const home = await homeFolder(user)
    const parentId = url.searchParams.get('folderId') || home
    json(res, 200, { items: listDriveChildren(user.alias, parentId).map(toClient) })
  })
}
