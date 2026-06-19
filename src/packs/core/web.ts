import { nativeBlock } from '../../pack/types'
import type { ExecutionContext } from '../../core/context'

/**
 * web.read — the high-level "eyes" primitive for perceiving a web page.
 *
 * Unlike the low-level browser.* primitives (browser.goto, browser.extract_text,
 * browser.snapshot, browser.screenshot) this block does all of it in one shot:
 * navigate, settle, extract main content, capture interactive elements, attach a
 * screenshot and full-text artifact, and return a COMPACT observation designed to
 * fit in a context window without overwhelming it.
 *
 * The full text and screenshot are offloaded to artifacts; the inline `text`
 * output is clamped to `maxChars` (default 2000). This is the compression
 * contract: a few hundred tokens inline, bulk offloaded.
 */

/** A single captured console message — mirrors browser.ts ConsoleEntry. */
interface ConsoleEntry {
  type: string
  text: string
}

/** Minimal structural view of the BrowserCap set up by browserCapability. */
interface BrowserCap {
  browser: unknown
  context: unknown
  page: BrowserPage
  consoleLog: ConsoleEntry[]
  network: unknown[]
}

/** Structural view of the Playwright Page methods web.read needs. */
interface BrowserPage {
  goto: (
    url: string,
    opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number },
  ) => Promise<unknown>
  url: () => string
  title: () => Promise<string>
  screenshot: (opts?: { mask?: unknown[] }) => Promise<Buffer>
  innerText: (selector: string) => Promise<string>
  evaluate: (expression: string) => Promise<unknown>
  waitForSelector: (
    selector: string,
    opts?: { timeout?: number },
  ) => Promise<unknown>
}

/** Pull the Playwright page from ctx, throws if browser capability is absent. */
function page(ctx: ExecutionContext): BrowserPage {
  const cap = ctx.capabilities.browser as BrowserCap | undefined
  if (!cap?.page) throw new Error('browser capability not available for this run')
  return cap.page
}

/** Normalize whitespace in extracted text. */
function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * In-page script: extract main-content text. Prefers <main>, <article>,
 * or [role=main] over <body> so nav/footer noise is excluded when a semantic
 * landmark is present. Falls back to body if none of the preferred targets exist
 * or they are empty (< 100 chars, i.e. skeleton containers).
 */
const MAIN_TEXT_SCRIPT = `(() => {
  const preferredSelectors = ['main', 'article', '[role="main"]']
  for (const sel of preferredSelectors) {
    const el = document.querySelector(sel)
    if (el) {
      const t = (el.innerText || '').trim()
      if (t.length >= 100) return t
    }
  }
  return (document.body ? document.body.innerText : '') || ''
})()`

/**
 * In-page script: enumerate visible interactive elements, capped at 30.
 * Reuses the same role/name/selector logic as browser.snapshot.
 */
const ELEMENTS_SCRIPT = `(() => {
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
  const MAX = 30
  const all = Array.from(document.querySelectorAll(SELECTOR)).filter(visible).slice(0, MAX)
  return all.map((el) => {
    const out = { role: roleOf(el), name: nameOf(el), selector: selectorFor(el) }
    const href = el.getAttribute && el.getAttribute('href')
    if (href) out.href = href
    return out
  })
})()`

export const webRead = nativeBlock(
  {
    id: 'web.read',
    name: 'Web: Read',
    version: '0.1.0',
    description:
      'The high-level "read a page" block — navigates to a URL, waits for the page to settle ' +
      '(including JS-rendered SPAs via `waitFor`), and returns a COMPACT observation: clamped ' +
      'inline text, a capped interactive-element map, console errors, and paths to the ' +
      'screenshot and full-text artifacts. Unlike the low-level browser.* primitives this does ' +
      'all perception in one step — the whole point is COMPRESSION (inline ≤ maxChars tokens, ' +
      'bulk offloaded to artifacts).',
    category: 'browser',
    keywords: ['web', 'read', 'page', 'perceive', 'render', 'spa', 'content', 'see', 'screenshot'],
    examples: [
      {
        description: 'Read the main content of a SPA that renders late',
        inputs: { url: 'https://example.com', waitFor: '#app-content', maxChars: 2000 },
      },
      {
        description: 'Read just the article section of a news page',
        inputs: { url: 'https://news.example.com/story', focus: 'article' },
      },
    ],
    capabilities: ['browser'],
    inputs: [
      { name: 'url', type: 'string', required: true },
      {
        name: 'focus',
        type: 'string',
        description:
          'CSS selector to read just that section (e.g. "article", "#content"). ' +
          'Omit to use the main-content heuristic (prefers <main>/<article>/<[role=main]>).',
      },
      {
        name: 'waitFor',
        type: 'string',
        description:
          'CSS selector to wait for before reading — useful for SPAs that inject content ' +
          'after page load. Degraded gracefully: a timeout just sets settled=false.',
      },
      {
        name: 'maxChars',
        type: 'number',
        description:
          'Maximum characters for the inline `text` output (default 2000). ' +
          'The full text is always saved to the fullText artifact.',
      },
    ],
    outputs: [
      { name: 'url', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'text', type: 'string' },
      { name: 'truncated', type: 'boolean' },
      { name: 'elements', type: 'array' },
      { name: 'consoleErrors', type: 'object' },
      { name: 'screenshot', type: 'string' },
      { name: 'fullText', type: 'string' },
      { name: 'settled', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const p = page(ctx)
    const cap = ctx.capabilities.browser as BrowserCap

    const targetUrl = String(inputs.url)
    const maxChars = typeof inputs.maxChars === 'number' && inputs.maxChars > 0 ? inputs.maxChars : 2000
    const focusSel = inputs.focus ? String(inputs.focus) : null
    const waitForSel = inputs.waitFor ? String(inputs.waitFor) : null

    // 1. Navigate and wait for network to settle.
    await p.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })

    // 2. Optionally wait for a late-rendered element (SPA settle).
    let settled = true
    if (waitForSel) {
      try {
        await p.waitForSelector(waitForSel, { timeout: 10000 })
      } catch {
        settled = false
      }
    }

    // 3. Extract main readable content.
    let fullText: string
    if (focusSel) {
      try {
        fullText = await p.innerText(focusSel)
      } catch {
        // Selector not found — fall back to main-content heuristic.
        fullText = String(await p.evaluate(MAIN_TEXT_SCRIPT))
      }
    } else {
      fullText = String(await p.evaluate(MAIN_TEXT_SCRIPT))
    }
    fullText = normalizeWhitespace(fullText)

    // 4. Clamp for inline output.
    const truncated = fullText.length > maxChars
    const text = truncated ? fullText.slice(0, maxChars) : fullText

    // 5. Build capped interactive-element map (≤ 30 elements, same logic as browser.snapshot).
    const elements = (await p.evaluate(ELEMENTS_SCRIPT)) as Array<{
      role: string
      name: string
      selector: string
      href?: string
    }>

    // 6. Console errors from the captured log (accumulated since navigation).
    const errorEntries = (cap.consoleLog ?? []).filter((e) => e.type === 'error')
    const consoleErrors = {
      count: errorEntries.length,
      sample: errorEntries.slice(0, 3).map((e) => e.text),
    }

    // 7. Screenshot → artifact.
    const buf = await p.screenshot()
    const screenshotPath = ctx.artifacts.attach('web-read.png', buf, { kind: 'screenshot' })

    // 8. Full text → artifact (save as Buffer/string; attach accepts both).
    const fullTextPath = ctx.artifacts.attach('web-read.txt', fullText, {
      mime: 'text/plain',
      kind: 'file',
    })

    return {
      url: p.url(),
      title: await p.title(),
      text,
      truncated,
      elements,
      consoleErrors,
      screenshot: screenshotPath,
      fullText: fullTextPath,
      settled,
    }
  },
)
