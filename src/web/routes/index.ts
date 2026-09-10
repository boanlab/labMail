import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router } from '../router.ts'
import { registerAuthRoutes } from './auth.ts'
import { registerMailRoutes } from './mail.ts'
import { registerAdminRoutes } from './admin.ts'
import { registerOAuthRoutes } from './oauth.ts'
import { registerDriveRoutes } from './drive.ts'
import { registerOrganizeRoutes } from './organize.ts'

const webDir = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Paths the single-page app owns.
 *
 * Registered explicitly rather than as a catch-all so an unknown path is still
 * a 404 — a typo should not silently render the app — and so nothing shadows
 * the API routes.
 */
const MAILBOXES = ['inbox', 'sent', 'archive', 'trash', 'spam', 'drafts']
const VIEWS = ['settings', 'members', 'profile', 'files', 'audit', 'unassigned']

function registerAppShell(router: Router): void {
  const serveShell = async ({ res }: { res: import('node:http').ServerResponse }) => {
    const html = await readFile(join(webDir, 'app.html'), 'utf8')
    // The shell is one file the client re-reads on every deploy; letting a
    // browser cache it would serve yesterday's app against today's API.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(html)
  }
  router.get('/', serveShell)
  router.get('/index.html', serveShell)
  for (const mailbox of MAILBOXES) {
    router.get(`/${mailbox}`, serveShell)
    // A thread open in the reader is its own address, so a reload keeps it.
    router.get(`/${mailbox}/:id`, serveShell)
  }
  for (const view of VIEWS) router.get(`/${view}`, serveShell)
  // A category is a mailbox-shaped view addressed by id.
  router.get('/category/:id', serveShell)
}

/** Every route the server exposes, in one place. */
export function createRouter(): Router {
  return new Router()
    .use(registerAppShell)
    .use(registerAuthRoutes)
    .use(registerMailRoutes)
    .use(registerDriveRoutes)
    .use(registerOrganizeRoutes)
    .use(registerAdminRoutes)
    .use(registerOAuthRoutes)
}
