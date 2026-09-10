import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveLocale, type Locale } from '../core/i18n.ts'
import { HttpError } from './http.ts'

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  /** Values captured from `:name` segments in the route pattern. */
  params: Record<string, string>
  /** Locale for any message this request returns in its body. */
  locale: Locale
}

export type Handler = (ctx: RequestContext) => Promise<void> | void

interface CompiledRoute {
  method: string
  regex: RegExp
  paramNames: string[]
  handler: Handler
}

/**
 * Compile a path pattern into a matcher.
 * Parameters match one segment and exclude `/`.
 */
function compile(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      paramNames.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { regex: new RegExp(`^${source}$`), paramNames }
}

/** Minimal router. Routes are declared per domain under `routes/`. */
export class Router {
  #routes: CompiledRoute[] = []

  add(method: string, pattern: string, handler: Handler): this {
    const { regex, paramNames } = compile(pattern)
    this.#routes.push({ method: method.toUpperCase(), regex, paramNames, handler })
    return this
  }

  get(pattern: string, handler: Handler) { return this.add('GET', pattern, handler) }
  post(pattern: string, handler: Handler) { return this.add('POST', pattern, handler) }

  use(register: (router: Router) => void): this {
    register(this)
    return this
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    let pathMatched = false

    for (const route of this.#routes) {
      const match = route.regex.exec(url.pathname)
      if (!match) continue
      pathMatched = true
      if (route.method !== method) continue

      const params: Record<string, string> = {}
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1] ?? '') })
      await route.handler({ req, res, url, params, locale: resolveLocale(req) })
      return
    }

    // 405 vs 404: distinguishes a wrong method from an unknown path.
    throw pathMatched
      ? new HttpError(405, 'error.methodNotAllowed')
      : new HttpError(404, 'error.notFound')
  }
}
