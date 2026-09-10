import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG, LOCALES, DEFAULT_LOCALE, isLocale, resolveLocale, t } from '../src/core/i18n.ts'
import type { IncomingMessage } from 'node:http'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const placeholdersOf = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

const fakeRequest = (headers: Record<string, string>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage)

test('exactly two locales are supported', () => {
  assert.deepEqual([...LOCALES], ['ko', 'en'])
  assert.equal(DEFAULT_LOCALE, 'ko')
})

test('isLocale accepts only the supported pair', () => {
  assert.ok(isLocale('ko'))
  assert.ok(isLocale('en'))
  for (const other of ['ja', 'zh', 'fr', 'en-US', 'KO', '', 'kor']) {
    assert.equal(isLocale(other), false, `${other} must not be accepted`)
  }
})

test('an unsupported Accept-Language falls back to the default', () => {
  assert.equal(resolveLocale(fakeRequest({ 'accept-language': 'fr-FR,fr;q=0.9' })), DEFAULT_LOCALE)
  assert.equal(resolveLocale(fakeRequest({})), DEFAULT_LOCALE)
})

test('Accept-Language honors quality ordering and region subtags', () => {
  assert.equal(resolveLocale(fakeRequest({ 'accept-language': 'en-GB,en;q=0.9' })), 'en')
  assert.equal(resolveLocale(fakeRequest({ 'accept-language': 'fr;q=0.9,en;q=0.8' })), 'en')
  assert.equal(resolveLocale(fakeRequest({ 'accept-language': 'en;q=0.3,ko;q=0.9' })), 'ko')
})

test('the locale cookie overrides Accept-Language', () => {
  const req = fakeRequest({ 'accept-language': 'ko', cookie: 'labmail_lang=en; other=1' })
  assert.equal(resolveLocale(req), 'en')
})

test('an invalid cookie value falls through rather than being trusted', () => {
  const req = fakeRequest({ 'accept-language': 'en', cookie: 'labmail_lang=de' })
  assert.equal(resolveLocale(req), 'en')
})

test('placeholders are substituted, and unknown ones left visible', () => {
  assert.equal(t('en', 'member.aliasTaken', { alias: 'a@b.c' }), 'a@b.c is already in use.')
  assert.match(t('en', 'member.aliasTaken', {}), /\{alias\}/)
})


/**
 * Extract the JSON object literal starting at `open` (the index of its `{`).
 *
 * Brace counting rather than a lastIndexOf heuristic: the catalog holds nested
 * braces inside `{placeholder}` templates, which a naive scan mis-slices.
 */
function extractObject(text: string, open: number): Record<string, string> {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        // Trailing commas are valid JavaScript and idiomatic in the catalog,
        // but not valid JSON. Stripping them is safe here because a JSON string
        // cannot contain a literal newline, so this pattern is always structural.
        const literal = text.slice(open, i + 1).replace(/,(\s*\n\s*})/g, '$1')
        return JSON.parse(literal) as Record<string, string>
      }
    }
  }
  throw new Error('unterminated object literal')
}

/** Both browser catalogs, parsed out of the single-file client. */
function browserCatalogs(html: string): { ko: Record<string, string>; en: Record<string, string> } {
  const start = html.indexOf('const STRINGS = {')
  if (start < 0) throw new Error('STRINGS catalog not found in app.html')
  const koOpen = html.indexOf('{', html.indexOf('  ko:', start))
  const ko = extractObject(html, koOpen)
  const enOpen = html.indexOf('{', html.indexOf('  en:', koOpen))
  const en = extractObject(html, enOpen)
  return { ko, en }
}

/**
 * Catalog parity.
 *
 * A key present in one language and missing from the other silently falls back,
 * so the gap only shows up in front of a user.
 */
function assertCatalogParity(
  name: string,
  ko: Record<string, string>,
  en: Record<string, string>,
): void {
  const koKeys = Object.keys(ko).sort()
  const enKeys = Object.keys(en).sort()

  assert.deepEqual(
    koKeys.filter((k) => !enKeys.includes(k)), [],
    `${name}: keys missing an English translation`,
  )
  assert.deepEqual(
    enKeys.filter((k) => !koKeys.includes(k)), [],
    `${name}: keys missing a Korean translation`,
  )

  for (const key of koKeys) {
    assert.deepEqual(
      placeholdersOf(en[key]!), placeholdersOf(ko[key]!),
      `${name}: placeholders differ between languages for "${key}"`,
    )
    assert.ok(ko[key]!.trim(), `${name}: "${key}" is empty in Korean`)
    assert.ok(en[key]!.trim(), `${name}: "${key}" is empty in English`)
  }
}

test('server catalog covers both languages identically', () => {
  // Compared directly rather than through t(): the default-locale fallback
  // would otherwise return Korean for a missing English key and hide the gap.
  const ko = CATALOG.ko as Record<string, string>
  const en = CATALOG.en as Record<string, string>
  assert.ok(Object.keys(ko).length > 20, 'expected a populated message catalog')
  assertCatalogParity('server', ko, en)
})

test('t() falls back to the default locale rather than leaking a key', () => {
  const key = Object.keys(CATALOG.ko)[0] as never
  assert.equal(t('ko', key), (CATALOG.ko as Record<string, string>)[key])
  assert.notEqual(t('en', key), key)
})

test('the two catalogs describe the supported locales and nothing else', () => {
  assert.deepEqual(Object.keys(CATALOG).sort(), ['en', 'ko'])
})

test('browser catalog covers both languages identically', () => {
  const html = readFileSync(join(repoRoot, 'src/web/app.html'), 'utf8')
  const { ko, en } = browserCatalogs(html)
  assert.ok(Object.keys(ko).length > 100, 'expected a populated browser catalog')
  assertCatalogParity('browser', ko, en)
})

test('every key the browser references is defined', () => {
  const html = readFileSync(join(repoRoot, 'src/web/app.html'), 'utf8')
  const script = html.slice(html.indexOf('<script type="module">'))
  const { ko } = browserCatalogs(html)

  const used = new Set<string>()
  for (const m of script.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(m[1]!)
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([\w.]+)"/g)) used.add(m[1]!)

  const undefined_ = [...used].filter((key) => !(key in ko))
  assert.deepEqual(undefined_, [], 'referenced without a translation')
})

test('the browser exposes only the supported languages', () => {
  const html = readFileSync(join(repoRoot, 'src/web/app.html'), 'utf8')
  const labels = html.match(/const LOCALE_LABEL = \{([^}]*)\}/)?.[1] ?? ''
  const codes = [...labels.matchAll(/(\w+):/g)].map((m) => m[1]!)
  assert.deepEqual(codes.sort(), ['en', 'ko'])
})
