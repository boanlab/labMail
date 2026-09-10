import { DEFAULT_LOCALE, t, type MessageKey } from './i18n.ts'

/**
 * An error with a translatable message, carried by key.
 *
 * Its own module rather than users.ts: categories, rules and sync all raise it,
 * and importing users.ts for the class alone would close a cycle through the
 * sync path.
 */
export class UserError extends Error {
  status = 400
  key: MessageKey
  params: Record<string, string | number>

  constructor(key: MessageKey, params: Record<string, string | number> = {}) {
    super(t(DEFAULT_LOCALE, key, params))
    this.key = key
    this.params = params
    this.name = 'UserError'
  }
}
