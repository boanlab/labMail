import { Readable } from 'node:stream'
import { google } from 'googleapis'
import { db, getDriveItemForAlias, listDriveChildren, driveUsage, type DriveRow } from '../db/index.ts'
import { sharedAccountAuth } from './client.ts'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ROOT_FOLDER_NAME = 'labMail'

/** Marks every item labMail creates, so ownership survives a lost database. */
const OWNER_PROPERTY = 'labmailOwner'

function drive() {
  return google.drive({ version: 'v3', auth: sharedAccountAuth() })
}

const denied = (message: string, key: 'drive.notFound' | 'drive.nameInvalid') =>
  Object.assign(new Error(message), { status: 404, key })

/** A name safe to write into a Drive folder listing. */
export function validateItemName(name: string): string {
  const clean = name.replace(/[\r\n\t\/\\]/g, '').trim().slice(0, 120)
  if (!clean || clean === '.' || clean === '..') {
    throw Object.assign(new Error('Invalid name'), { status: 400, key: 'drive.nameInvalid' as const })
  }
  return clean
}

const mirror = db.prepare(`
  INSERT INTO drive_files (file_id, alias, parent_id, name, mime_type, size_bytes, is_folder, modified_at, synced_at)
  VALUES (@file_id, @alias, @parent_id, @name, @mime_type, @size_bytes, @is_folder, @modified_at, datetime('now'))
  ON CONFLICT (file_id) DO UPDATE SET
    parent_id = excluded.parent_id,
    name = excluded.name,
    mime_type = excluded.mime_type,
    size_bytes = excluded.size_bytes,
    modified_at = excluded.modified_at,
    synced_at = datetime('now')
`)

interface DriveApiFile {
  id?: string | null
  name?: string | null
  mimeType?: string | null
  size?: string | null
  parents?: string[] | null
  modifiedTime?: string | null
}

function record(alias: string, file: DriveApiFile, parentId: string): DriveRow {
  const row = {
    file_id: file.id!,
    alias,
    parent_id: file.parents?.[0] ?? parentId,
    name: file.name ?? '',
    mime_type: file.mimeType ?? 'application/octet-stream',
    size_bytes: Number(file.size ?? 0),
    is_folder: file.mimeType === FOLDER_MIME ? 1 : 0,
    modified_at: file.modifiedTime ?? null,
  }
  mirror.run(row)
  return row as DriveRow
}

/**
 * The member's home folder, created if absent. Called at approval, and on first
 * use for an account that never went through it.
 */
export async function ensureHomeFolder(userId: number, alias: string): Promise<string> {
  const user = db.prepare(`SELECT drive_folder_id, alias_local FROM users WHERE id = ?`)
    .get(userId) as { drive_folder_id: string | null; alias_local: string | null } | undefined
  if (user?.drive_folder_id) return user.drive_folder_id

  const api = drive()

  // One labMail root, rather than member folders across Drive's top level.
  const existingRoot = await api.files.list({
    q: `name = '${ROOT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  })
  let rootId = existingRoot.data.files?.[0]?.id
  if (!rootId) {
    const created = await api.files.create({
      requestBody: { name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME },
      fields: 'id',
    })
    rootId = created.data.id!
  }

  const home = await api.files.create({
    requestBody: {
      name: user?.alias_local ?? alias.split('@')[0]!,
      mimeType: FOLDER_MIME,
      parents: [rootId],
      appProperties: { [OWNER_PROPERTY]: alias },
    },
    fields: 'id, name, mimeType, parents, modifiedTime',
  })

  const folderId = home.data.id!
  db.prepare(`UPDATE users SET drive_folder_id = ? WHERE id = ?`).run(folderId, userId)
  record(alias, home.data, rootId)
  return folderId
}

export function homeFolderOf(alias: string): string | null {
  const row = db.prepare(`SELECT drive_folder_id FROM users WHERE alias_email = ?`).get(alias) as
    | { drive_folder_id: string | null }
    | undefined
  return row?.drive_folder_id ?? null
}

/**
 * Resolve a folder id the caller may read. Absent means home; anything else
 * must match a recorded row for this alias.
 */
function resolveFolder(alias: string, folderId?: string): string {
  const home = homeFolderOf(alias)
  if (!home) throw Object.assign(new Error('No Drive folder'), { status: 409, key: 'drive.noFolder' as const })
  if (!folderId || folderId === home) return home
  const row = getDriveItemForAlias(alias, folderId)
  if (!row || row.is_folder !== 1) throw denied('Folder not found', 'drive.notFound')
  return folderId
}

/** List a folder, refreshing the mirror from Drive as it goes. */
export async function listFolder(alias: string, folderId?: string) {
  const parentId = resolveFolder(alias, folderId)
  const api = drive()

  const res = await api.files.list({
    q: `'${parentId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, parents, modifiedTime)',
    orderBy: 'folder,name',
    pageSize: 200,
  })

  const seen = new Set<string>()
  const items = (res.data.files ?? []).map((file) => {
    seen.add(file.id!)
    return record(alias, file, parentId)
  })

  // Drop rows for anything removed outside labMail.
  const known = listDriveChildren(alias, parentId)
  const stale = known.filter((row: DriveRow) => !seen.has(row.file_id))
  if (stale.length) {
    const remove = db.prepare(`DELETE FROM drive_files WHERE file_id = ?`)
    db.transaction(() => { for (const row of stale) remove.run(row.file_id) })()
  }

  return { parentId, isHome: parentId === homeFolderOf(alias), items }
}

/** Breadcrumb from the member's home folder down to the open one. */
export function pathTo(alias: string, folderId: string): DriveRow[] {
  const home = homeFolderOf(alias)
  const trail: DriveRow[] = []
  let current = folderId
  // Bounded: a cycle in the mirror must not spin here.
  for (let depth = 0; depth < 32 && current && current !== home; depth++) {
    const row = getDriveItemForAlias(alias, current)
    if (!row) break
    trail.unshift(row)
    current = row.parent_id
  }
  return trail
}

export async function createFolder(alias: string, name: string, parentId?: string) {
  const parent = resolveFolder(alias, parentId)
  const created = await drive().files.create({
    requestBody: {
      name: validateItemName(name),
      mimeType: FOLDER_MIME,
      parents: [parent],
      appProperties: { [OWNER_PROPERTY]: alias },
    },
    fields: 'id, name, mimeType, size, parents, modifiedTime',
  })
  return record(alias, created.data, parent)
}

export async function uploadFile(
  alias: string,
  name: string,
  mimeType: string,
  content: Buffer,
  parentId?: string,
) {
  const parent = resolveFolder(alias, parentId)
  const created = await drive().files.create({
    requestBody: {
      name: validateItemName(name),
      parents: [parent],
      appProperties: { [OWNER_PROPERTY]: alias },
    },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(content) },
    fields: 'id, name, mimeType, size, parents, modifiedTime',
  })
  return record(alias, created.data, parent)
}

export async function renameItem(alias: string, fileId: string, name: string) {
  const row = getDriveItemForAlias(alias, fileId)
  if (!row) throw denied('Not found', 'drive.notFound')
  const updated = await drive().files.update({
    fileId,
    requestBody: { name: validateItemName(name) },
    fields: 'id, name, mimeType, size, parents, modifiedTime',
  })
  return record(alias, updated.data, row.parent_id)
}

/** Move to Drive's trash, matching how mail deletion behaves. */
export async function trashItem(alias: string, fileId: string): Promise<void> {
  const row = getDriveItemForAlias(alias, fileId)
  if (!row) throw denied('Not found', 'drive.notFound')
  await drive().files.update({ fileId, requestBody: { trashed: true } })
  db.prepare(`DELETE FROM drive_files WHERE file_id = ?`).run(fileId)
}

export async function downloadFile(alias: string, fileId: string) {
  const row = getDriveItemForAlias(alias, fileId)
  if (!row || row.is_folder === 1) throw denied('Not found', 'drive.notFound')
  const res = await drive().files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  )
  return { name: row.name, mimeType: row.mime_type, content: Buffer.from(res.data as ArrayBuffer) }
}

/**
 * A link the recipient of a message can open. Read access to anyone holding it;
 * whether the domain permits that at all is an Admin console policy.
 */
export async function shareableLink(alias: string, fileId: string) {
  const row = getDriveItemForAlias(alias, fileId)
  if (!row) throw denied('Not found', 'drive.notFound')

  const api = drive()
  await api.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  }).catch((err: { code?: number }) => {
    // Already shared is fine; a policy refusal is not, and should surface.
    if (err?.code !== 400) throw err
  })
  const meta = await api.files.get({ fileId, fields: 'webViewLink' })
  return { name: row.name, size: row.size_bytes, link: meta.data.webViewLink ?? '' }
}

/** Bytes this member holds, beside the whole account's quota. */
export async function usage(alias: string) {
  const mine = driveUsage(alias)
  const about = await drive().about.get({ fields: 'storageQuota' })
  const quota = about.data.storageQuota ?? {}
  return {
    mine,
    accountUsed: Number(quota.usage ?? 0),
    accountLimit: quota.limit ? Number(quota.limit) : null,
  }
}
