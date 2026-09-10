import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeHtml, hasContent } from '../src/google/sanitize.ts'

test('keeps ordinary formatting markup', () => {
  const html = '<p>Hello <b>bold</b> and <i>italic</i> and <u>under</u></p><ul><li>one</li></ul>'
  assert.equal(sanitizeHtml(html), html)
})

test('removes scripts along with their contents', () => {
  assert.equal(sanitizeHtml('<p>before</p><script>steal()</script><p>after</p>'),
    '<p>before</p><p>after</p>')
  assert.equal(sanitizeHtml('<script src="https://evil.net/x.js"></script>ok'), 'ok')
})

test('removes style and embedded frames', () => {
  assert.equal(sanitizeHtml('<style>p{}</style><p>x</p>'), '<p>x</p>')
  assert.equal(sanitizeHtml('<iframe src="https://evil.net"></iframe>x'), 'x')
  assert.equal(sanitizeHtml('<object data="x"></object>y'), 'y')
})

test('strips event handlers while keeping the element', () => {
  assert.equal(sanitizeHtml('<p onclick="steal()">text</p>'), '<p>text</p>')
  assert.equal(sanitizeHtml('<b onmouseover=alert(1)>t</b>'), '<b>t</b>')
})

test('drops disallowed tags but keeps their text', () => {
  assert.equal(sanitizeHtml('<form><input>keep this<button>x</button></form>'), 'keep thisx')
  assert.equal(sanitizeHtml('<marquee>text</marquee>'), 'text')
})

test('allows only http, https and mailto links', () => {
  assert.match(sanitizeHtml('<a href="https://example.com">ok</a>'), /href="https:\/\/example\.com"/)
  assert.match(sanitizeHtml('<a href="mailto:a@b.com">ok</a>'), /href="mailto:a@b\.com"/)
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '/relative']) {
    const out = sanitizeHtml(`<a href="${bad}">click</a>`)
    assert.ok(!out.includes('href='), `${bad} must not survive: ${out}`)
    assert.ok(out.includes('click'), 'link text is kept')
  }
})

test('links carry target and rel guards', () => {
  const out = sanitizeHtml('<a href="https://example.com">x</a>')
  assert.ok(out.includes('target="_blank"'))
  assert.ok(out.includes('rel="noopener noreferrer"'))
})

test('drops attributes that are not on the allowlist', () => {
  const out = sanitizeHtml('<a href="https://a.b" id="x" style="display:none" onclick="y()">t</a>')
  assert.ok(!out.includes('id=') && !out.includes('style=') && !out.includes('onclick='))
  assert.ok(out.includes('href="https://a.b"'))
})

test('comments cannot smuggle markup past the filter', () => {
  assert.equal(sanitizeHtml('<!-- <script>x()</script> -->safe'), 'safe')
})

test('void elements are normalized', () => {
  assert.equal(sanitizeHtml('a<br/>b<br>c'), 'a<br>b<br>c')
  assert.equal(sanitizeHtml('<hr />'), '<hr>')
})

/**
 * Attribute names on the first tag, read the way a parser reads them.
 *
 * The value has to be consumed along with the name; scanning for `name=` alone
 * finds text inside a quoted value and reports attributes that do not exist.
 */
function attributeNames(html: string): string[] {
  const tag = html.match(/<[a-z]+\b([^>]*)>/i)?.[1] ?? ''
  const names: string[] = []
  const pair = /([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g
  let match: RegExpExecArray | null
  while ((match = pair.exec(tag)) !== null) names.push(match[1]!.toLowerCase())
  return names
}

test('quotes inside an attribute value cannot start a new attribute', () => {
  // The escaped entity stays inside the value: a parser decodes it only after
  // the attribute boundary is fixed, so it cannot introduce onclick.
  const out = sanitizeHtml('<a href="https://a.b/&quot; onclick=&quot;evil()">t</a>')
  assert.deepEqual(attributeNames(out).sort(), ['href', 'rel', 'target'])
})

test('only allowlisted attributes reach the output', () => {
  const out = sanitizeHtml('<a href="https://a.b" title="t" id="x" onclick="y()" srcset="z">link</a>')
  assert.deepEqual(attributeNames(out).sort(), ['href', 'rel', 'target', 'title'])
})

test('hasContent distinguishes real text from empty markup', () => {
  assert.equal(hasContent('<p><br></p>'), false)
  assert.equal(hasContent('<p>&nbsp;</p>'), false)
  assert.equal(hasContent('   '), false)
  assert.equal(hasContent('<p>text</p>'), true)
  assert.equal(hasContent('<p><b>x</b></p>'), true)
})

test('entity-encoded schemes cannot bypass the URL check', () => {
  for (const bad of [
    'java&#115;cript:alert(1)',
    '&#106;avascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    '&#x6a;avascript:alert(1)',
  ]) {
    const out = sanitizeHtml(`<a href="${bad}">click</a>`)
    assert.ok(!/href=/.test(out), `${JSON.stringify(bad)} must not survive: ${out}`)
  }
})

test('a legitimate query string survives escaping intact', () => {
  const out = sanitizeHtml('<a href="https://a.b/s?x=1&y=2">t</a>')
  // & must be written as &amp; in an attribute; it decodes back to & for the reader.
  assert.ok(out.includes('href="https://a.b/s?x=1&amp;y=2"'), out)
})

// ── Inline style ────────────────────────────────────────────────────────────

test('allowed style properties survive', () => {
  const out = sanitizeHtml('<span style="color:#c00;font-size:18px">red</span>')
  assert.match(out, /color:#c00/)
  assert.match(out, /font-size:18px/)
})

test('alignment survives on a block', () => {
  assert.match(sanitizeHtml('<p style="text-align:center">mid</p>'), /text-align:center/)
})

test('an unlisted property is dropped, keeping the rest', () => {
  const out = sanitizeHtml('<span style="color:red;position:fixed;top:0">x</span>')
  assert.match(out, /color:red/)
  assert.doesNotMatch(out, /position/)
  assert.doesNotMatch(out, /top/)
})

test('url() cannot ride in on an allowed property', () => {
  const out = sanitizeHtml('<span style="background-color:url(javascript:alert(1))">x</span>')
  assert.doesNotMatch(out, /url\(/i)
  assert.doesNotMatch(out, /javascript/i)
})

test('expression() is not a value any property accepts', () => {
  const out = sanitizeHtml('<span style="color:expression(alert(1))">x</span>')
  assert.doesNotMatch(out, /expression/i)
})

test('an entity-encoded value is judged after decoding', () => {
  // The recipient's parser decodes first, so the check has to as well.
  const out = sanitizeHtml('<span style="color:&#106;avascript:alert(1)">x</span>')
  assert.doesNotMatch(out, /javascript/i)
})

test('a quote inside a style value cannot end the attribute', () => {
  const out = sanitizeHtml('<span style=\'color:red" onmouseover="alert(1)\'>x</span>')
  assert.doesNotMatch(out, /onmouseover/i)
})

test('style is refused on a tag that may not carry one', () => {
  assert.doesNotMatch(sanitizeHtml('<a href="https://e.test" style="color:red">x</a>'), /style=/)
})

test('a style-only attribute list does not resurrect other attributes', () => {
  const out = sanitizeHtml('<span style="color:red" onclick="alert(1)" id="x">t</span>')
  assert.match(out, /color:red/)
  assert.doesNotMatch(out, /onclick/i)
  assert.doesNotMatch(out, /id=/)
})

test('an empty result drops the attribute rather than emitting style=""', () => {
  assert.doesNotMatch(sanitizeHtml('<span style="position:absolute">x</span>'), /style=/)
})
