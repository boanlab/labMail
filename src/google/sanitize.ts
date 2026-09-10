/**
 * Allowlist sanitizer for composed HTML. The composer is contenteditable, so
 * its markup carries whatever was pasted, and this output is mailed onward.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'hr',
])

/** Tags whose contents are dropped along with the tag. */
const VOID_CONTENT = new Set(['script', 'style', 'head', 'title', 'iframe', 'object', 'embed'])

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
}

/**
 * Inline style, as a fixed set of properties whose values are re-emitted from a
 * match rather than passed through. Nothing arrives verbatim, so `url(...)`,
 * `expression(...)` and the rest have no pattern to match.
 */
const ALLOWED_STYLES: Record<string, RegExp> = {
  color: /^#[0-9a-f]{3,8}$|^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$|^[a-z]{3,20}$/i,
  'background-color': /^#[0-9a-f]{3,8}$|^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$|^[a-z]{3,20}$/i,
  'text-align': /^(left|center|right|justify)$/i,
  'font-size': /^(0?\.\d+|[1-9]\d?(\.\d+)?)(px|pt|em|rem|%)$|^(x-small|small|medium|large|x-large|xx-large)$/i,
  'font-weight': /^(normal|bold|[1-9]00)$/i,
  'font-style': /^(normal|italic)$/i,
  'text-decoration': /^(none|underline|line-through)$/i,
  'margin-left': /^\d{1,3}(px|em)$/i,
}

/** Tags that may carry one. Anything else keeps no attributes at all. */
const STYLEABLE = new Set([
  'span', 'p', 'div', 'li', 'ul', 'ol', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'b', 'strong', 'i', 'em', 'u', 's',
])

/** Rebuilt from matches, so nothing unrecognised survives. */
function sanitizeStyle(raw: string): string {
  const kept: string[] = []
  for (const declaration of decodeEntities(raw).split(';')) {
    const [name, ...rest] = declaration.split(':')
    if (!name || rest.length === 0) continue
    const property = name.trim().toLowerCase()
    const pattern = ALLOWED_STYLES[property]
    if (!pattern) continue
    const value = rest.join(':').trim()
    if (!pattern.test(value)) continue
    kept.push(`${property}:${value}`)
  }
  return kept.join(';')
}

const SAFE_URL = /^(https?:|mailto:)/i

/**
 * Resolve entities before judging a value: the recipient's parser decodes them,
 * so `java&#115;cript:` is what a browser ultimately sees.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);?/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;?/gi, '"')
    .replace(/&apos;?/gi, "'")
    .replace(/&lt;?/gi, '<')
    .replace(/&gt;?/gi, '>')
    .replace(/&amp;?/gi, '&')
}

/**
 * Escape a value for an HTML attribute. `&` first, or a source `&quot;` decodes
 * back into a quote and ends the attribute early.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function sanitizeAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag]
  const styleable = STYLEABLE.has(tag)
  if (!allowed && !styleable) return ''

  const kept: string[] = []
  for (const match of raw.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1]!.toLowerCase()
    if (name === 'style' && styleable) {
      const style = sanitizeStyle(match[3] ?? match[4] ?? match[5] ?? '')
      if (style) kept.push(`style="${escapeAttribute(style)}"`)
      continue
    }
    if (!allowed?.has(name)) continue
    const value = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '')
    // Absolute http(s) and mailto only. Control characters go first, since
    // `java\tscript:` decodes to a scheme browsers still honour.
    const url = value.replace(/[\s\x00-\x1f]/g, '')
    if (name === 'href' && !SAFE_URL.test(url)) continue
    kept.push(`${name}="${escapeAttribute(name === 'href' ? url : value)}"`)
  }
  // Links leave the reader's mail client, so they carry the usual guards.
  if (tag === 'a' && kept.some((a) => a.startsWith('href='))) {
    kept.push('target="_blank"', 'rel="noopener noreferrer"')
  }
  return kept.length ? ` ${kept.join(' ')}` : ''
}

/** Strip everything outside the allowlist, dropping disallowed tags but keeping their text. */
export function sanitizeHtml(input: string): string {
  let html = input

  // Comments can hide markup from a naive parser; remove them first.
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of VOID_CONTENT) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
    html = html.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '')
  }

  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_, slash: string, name: string, attrs: string) => {
    const tag = name.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (slash) return `</${tag}>`
    if (tag === 'br' || tag === 'hr') return `<${tag}>`
    return `<${tag}${sanitizeAttributes(tag, attrs)}>`
  })
}

/** True when the markup carries something beyond whitespace. */
export function hasContent(html: string): boolean {
  return sanitizeHtml(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0
}
