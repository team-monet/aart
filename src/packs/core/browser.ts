import { nativeBlock, type Capability } from '../../pack/types'
import type { ExecutionContext } from '../../core/context'

/**
 * The `browser` capability. Playwright is imported lazily in setup() so the pack
 * loads (and api/assert blocks run) even if the browser binaries aren't present;
 * a browser block only needs them when it actually runs.
 */
interface BrowserCap {
  browser: { close: () => Promise<void> }
  context: unknown
  page: BrowserPage
}

// A minimal structural view of the Playwright Page methods we use.
interface BrowserPage {
  goto: (url: string) => Promise<unknown>
  url: () => string
  click: (selector: string) => Promise<void>
  fill: (selector: string, value: string) => Promise<void>
  locator: (selector: string) => unknown
  screenshot: (opts?: { mask?: unknown[] }) => Promise<Buffer>
  innerText: (selector: string) => Promise<string>
  innerHTML: (selector: string) => Promise<string>
  content: () => Promise<string>
  evaluate: (expression: string) => Promise<unknown>
  title: () => Promise<string>
  goBack: () => Promise<unknown>
  getByText: (text: string) => {
    first: () => { waitFor: (o: { state: string; timeout: number }) => Promise<void> }
  }
}

export const browserCapability: Capability = {
  name: 'browser',
  async setup() {
    const { chromium } = await import('playwright')
    let browser
    try {
      browser = await chromium.launch({ headless: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // The common Linux/WSL2 failure: binary downloaded but system libs missing.
      throw new Error(
        `failed to launch Chromium: ${msg}\n` +
          'Install the browser and its system libraries with:\n' +
          '  npx playwright install --with-deps chromium',
      )
    }
    const context = await browser.newContext()
    const page = await context.newPage()
    return { browser, context, page } as unknown as BrowserCap
  },
  async teardown(value) {
    const cap = value as BrowserCap | undefined
    if (cap?.browser) await cap.browser.close()
  },
}

function page(ctx: ExecutionContext): BrowserPage {
  const cap = ctx.capabilities.browser as BrowserCap | undefined
  if (!cap?.page) throw new Error('browser capability not available for this run')
  return cap.page
}

export const browserGoto = nativeBlock(
  {
    id: 'browser.goto',
    name: 'Browser: Goto',
    version: '0.1.0',
    description: 'Navigate the browser to a URL.',
    capabilities: ['browser'],
    inputs: [{ name: 'url', type: 'string', required: true }],
    outputs: [{ name: 'url', type: 'string' }],
  },
  async (ctx, inputs) => {
    const p = page(ctx)
    await p.goto(String(inputs.url))
    return { url: p.url() }
  },
)

export const browserClick = nativeBlock(
  {
    id: 'browser.click',
    name: 'Browser: Click',
    version: '0.1.0',
    description:
      'Click the element matching a selector — CSS (`#login`, `nav a`) or Playwright ' +
      'text engine (`text=Sign in`). Get ready-to-use selectors from browser.snapshot.',
    capabilities: ['browser'],
    inputs: [{ name: 'selector', type: 'string', required: true }],
    outputs: [{ name: 'clicked', type: 'string' }],
  },
  async (ctx, inputs) => {
    await page(ctx).click(String(inputs.selector))
    return { clicked: String(inputs.selector) }
  },
)

export const browserFill = nativeBlock(
  {
    id: 'browser.fill',
    name: 'Browser: Fill',
    version: '0.1.0',
    description:
      'Fill an input matching a selector (CSS or `text=`) with a value. ' +
      'Get ready-to-use selectors from browser.snapshot.',
    capabilities: ['browser'],
    inputs: [
      { name: 'selector', type: 'string', required: true },
      { name: 'value', type: 'string', required: true },
    ],
    outputs: [{ name: 'filled', type: 'string' }],
  },
  async (ctx, inputs) => {
    await page(ctx).fill(String(inputs.selector), String(inputs.value))
    return { filled: String(inputs.selector) }
  },
)

export const browserTextVisible = nativeBlock(
  {
    id: 'browser.text_visible',
    name: 'Browser: Text Visible',
    version: '0.1.0',
    description: 'Fail unless the given text becomes visible on the page.',
    capabilities: ['browser'],
    inputs: [
      { name: 'text', type: 'string', required: true },
      { name: 'timeoutMs', type: 'number' },
    ],
    outputs: [{ name: 'visible', type: 'boolean' }],
  },
  async (ctx, inputs) => {
    const text = String(inputs.text)
    const timeout = typeof inputs.timeoutMs === 'number' ? inputs.timeoutMs : 5000
    try {
      await page(ctx).getByText(text).first().waitFor({ state: 'visible', timeout })
    } catch {
      throw new Error(`Text not visible: ${text}`)
    }
    return { visible: true }
  },
)

/** Clamp extracted page content so a huge page can't balloon the run report. */
function clamp(raw: string, maxChars: unknown): { text: string; truncated: boolean } {
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 50_000
  return raw.length > limit
    ? { text: raw.slice(0, limit), truncated: true }
    : { text: raw, truncated: false }
}

export const browserExtractText = nativeBlock(
  {
    id: 'browser.extract_text',
    name: 'Browser: Extract Text',
    version: '0.1.0',
    description:
      'Return the rendered (post-JavaScript) text of the page — or of one element via ' +
      '`selector` — as a string output for later steps to parse or assert on. ' +
      'Truncated at `maxChars` (default 50000); `truncated` reports if clipping happened.',
    capabilities: ['browser'],
    inputs: [
      { name: 'selector', type: 'string' },
      { name: 'maxChars', type: 'number' },
    ],
    outputs: [
      { name: 'text', type: 'string' },
      { name: 'truncated', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const selector = inputs.selector ? String(inputs.selector) : 'body'
    const raw = await page(ctx).innerText(selector)
    const { text, truncated } = clamp(raw, inputs.maxChars)
    return { text, truncated }
  },
)

export const browserHtml = nativeBlock(
  {
    id: 'browser.html',
    name: 'Browser: HTML',
    version: '0.1.0',
    description:
      'Return the rendered HTML of the page — or of one element via `selector` — as a ' +
      'string output (e.g. for a node block to parse). Truncated at `maxChars` (default 50000).',
    capabilities: ['browser'],
    inputs: [
      { name: 'selector', type: 'string' },
      { name: 'maxChars', type: 'number' },
    ],
    outputs: [
      { name: 'html', type: 'string' },
      { name: 'truncated', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const p = page(ctx)
    const raw = inputs.selector ? await p.innerHTML(String(inputs.selector)) : await p.content()
    const { text, truncated } = clamp(raw, inputs.maxChars)
    return { html: text, truncated }
  },
)

export const browserEval = nativeBlock(
  {
    id: 'browser.eval',
    name: 'Browser: Eval',
    version: '0.1.0',
    description:
      'Evaluate a JavaScript expression in the live page and return its JSON-serializable ' +
      'result — element counts, attribute values, table data, anything the DOM knows. ' +
      'For plain page text/markup, prefer extract_text / html. The expression is part of ' +
      'the definition the user approves.',
    capabilities: ['browser'],
    inputs: [{ name: 'expression', type: 'string', required: true }],
    outputs: [{ name: 'result', type: 'any' }],
  },
  async (ctx, inputs) => {
    const raw = await page(ctx).evaluate(String(inputs.expression))
    let json: string | undefined
    try {
      json = JSON.stringify(raw === undefined ? null : raw)
    } catch {
      json = undefined
    }
    if (json === undefined) {
      throw new Error('expression returned a non-JSON-serializable value')
    }
    if (json.length > 200_000) {
      throw new Error(`expression result too large (${json.length} chars > 200000) — narrow the query`)
    }
    return { result: JSON.parse(json) as unknown }
  },
)

/**
 * In-page enumerator for browser.snapshot. Finds visible interactive elements
 * and derives, for each, a human-readable role/name and a selector that the
 * click/fill blocks accept directly (id > name attr > Playwright `text=` >
 * a short CSS path as last resort).
 */
const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [onclick]'
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  const roleOf = (el) => {
    const aria = el.getAttribute('role')
    if (aria) return aria
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button') return t
      return 'textbox'
    }
    return tag
  }
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || (el.innerText || '').trim() || el.value ||
      el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 80)
  const cssPath = (el) => {
    const parts = []
    let cur = el
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      let part = cur.tagName.toLowerCase()
      const parent = cur.parentElement
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'
      }
      parts.unshift(part)
      cur = parent
    }
    return parts.join(' > ')
  }
  const selectorFor = (el) => {
    if (el.id) return '#' + CSS.escape(el.id)
    const nm = el.getAttribute('name')
    if (nm && /^[\\w-]+$/.test(nm)) return el.tagName.toLowerCase() + '[name="' + nm + '"]'
    const txt = (el.innerText || '').trim().replace(/\\s+/g, ' ')
    if (txt && txt.length <= 40 && !txt.includes('"')) return 'text="' + txt + '"'
    return cssPath(el)
  }
  const all = Array.from(document.querySelectorAll(SELECTOR)).filter(visible)
  const elements = all.map((el) => {
    const out = { role: roleOf(el), name: nameOf(el), selector: selectorFor(el) }
    const href = el.getAttribute && el.getAttribute('href')
    if (href) out.href = href
    return out
  })
  return { url: location.href, title: document.title, elements, total: elements.length }
})()`

export const browserSnapshot = nativeBlock(
  {
    id: 'browser.snapshot',
    name: 'Browser: Snapshot',
    version: '0.1.0',
    description:
      'Map the current page for navigation: url, title, and every visible ' +
      'interactive element as { role, name, selector, href? } — each selector is ' +
      'directly usable with browser.click / browser.fill. Run this instead of ' +
      'guessing selectors from raw HTML; cap the list with `maxElements` (default 100).',
    capabilities: ['browser'],
    inputs: [{ name: 'maxElements', type: 'number' }],
    outputs: [
      { name: 'url', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'elements', type: 'array' },
      { name: 'total', type: 'number' },
      { name: 'truncated', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const raw = (await page(ctx).evaluate(SNAPSHOT_SCRIPT)) as {
      url: string
      title: string
      elements: unknown[]
      total: number
    }
    const limit =
      typeof inputs.maxElements === 'number' && inputs.maxElements > 0 ? inputs.maxElements : 100
    const truncated = raw.elements.length > limit
    return {
      url: raw.url,
      title: raw.title,
      elements: truncated ? raw.elements.slice(0, limit) : raw.elements,
      total: raw.total,
      truncated,
    }
  },
)

export const browserBack = nativeBlock(
  {
    id: 'browser.back',
    name: 'Browser: Back',
    version: '0.1.0',
    description: 'Go back one entry in the browser history; returns the resulting URL.',
    capabilities: ['browser'],
    inputs: [],
    outputs: [{ name: 'url', type: 'string' }],
  },
  async (ctx) => {
    const p = page(ctx)
    await p.goBack()
    return { url: p.url() }
  },
)

export const browserScreenshot = nativeBlock(
  {
    id: 'browser.screenshot',
    name: 'Browser: Screenshot',
    version: '0.1.0',
    description:
      'Capture a screenshot and attach it as an artifact. Pass `mask` (a list of ' +
      'selectors) to black out secret-bearing fields — artifact contents are NOT redacted.',
    capabilities: ['browser'],
    inputs: [
      { name: 'name', type: 'string', required: true },
      { name: 'mask', type: 'array' },
    ],
    outputs: [{ name: 'artifact', type: 'string' }],
  },
  async (ctx, inputs) => {
    const p = page(ctx)
    const mask = Array.isArray(inputs.mask)
      ? inputs.mask.map((s) => p.locator(String(s)))
      : undefined
    const buf = await p.screenshot(mask ? { mask } : undefined)
    const file = ctx.artifacts.attach(`${inputs.name}.png`, buf)
    return { artifact: file }
  },
)
