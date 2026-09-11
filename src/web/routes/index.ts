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
  registerInstallable(router)
  for (const mailbox of MAILBOXES) {
    router.get(`/${mailbox}`, serveShell)
    // A thread open in the reader is its own address, so a reload keeps it.
    router.get(`/${mailbox}/:id`, serveShell)
  }
  for (const view of VIEWS) router.get(`/${view}`, serveShell)
  // A category is a mailbox-shaped view addressed by id.
  router.get('/category/:id', serveShell)
}

/** Mark, in the browser's tab and on a home screen. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="5" fill="#2563eb"/>
  <path d="M5 8.5h14v8H5z" fill="none" stroke="#fff" stroke-width="1.6"
        stroke-linejoin="round"/>
  <path d="M5 9l7 5 7-5" fill="none" stroke="#fff" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

/**
 * What a browser needs before it will offer to install the app.
 *
 * A manifest, an icon, and a service worker with a fetch handler. The handler
 * deliberately answers nothing: LabMail is a live view of a mailbox, and a
 * cache serving yesterday's mail would be worse than no offline support at
 * all. Its only job is to satisfy the criterion.
 */
function registerInstallable(router: Router): void {
  router.get('/manifest.webmanifest', ({ res }) => {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' })
    res.end(JSON.stringify({
      name: 'LabMail',
      short_name: 'LabMail',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#2563eb',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    }))
  })

  router.get('/icon.svg', ({ res }) => {
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    })
    res.end(ICON)
  })

  router.get('/sw.js', ({ res }) => {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    })
    // No respondWith: every request goes to the network exactly as it would
    // without a worker at all.
    res.end("self.addEventListener('fetch', () => {})\n")
  })
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
