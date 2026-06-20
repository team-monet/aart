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
 *
 * When `expect` is provided the block also returns `matched` (boolean): true if
 * the phrase appears anywhere in the rendered page. When `focus` is set, matching
 * is scoped to the focused region; otherwise matching runs against the FULL body
 * text (not the clamped `text` output), so nav/header/footer phrases are found.
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
  waitForLoadState: (
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    opts?: { timeout?: number },
  ) => Promise<void>
  url: () => string
  title: () => Promise<string>
  locator: (selector: string) => unknown
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
      'The high-level "read a page" block — navigates to a URL, waits briefly for the page to ' +
      'settle (domcontentloaded plus a short best-effort network-idle wait), and returns a COMPACT ' +
      'observation: clamped inline text, a capped interactive-element map, console errors, and ' +
      'paths to the screenshot and full-text artifacts. For SPAs that render content several ' +
      'seconds after load, pass `waitFor` (a CSS selector) to wait for the right element before ' +
      'reading. For pages that show secrets, pass `mask` (CSS selectors) to black out those ' +
      'elements in the screenshot, or `screenshot: false` to skip the screenshot entirely. ' +
      'Unlike the low-level browser.* primitives this does all perception in one step — ' +
      'the whole point is COMPRESSION (inline ≤ maxChars tokens, bulk offloaded to artifacts).',
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
      {
        description: 'Check whether a phrase renders anywhere on the page (full-page match)',
        inputs: { url: 'https://example.com', expect: 'Get Started' },
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
      {
        name: 'expect',
        type: 'string',
        description:
          'Optional phrase to check for in the rendered page. Returns `matched` (boolean). ' +
          'When `focus` is set, matches within the focused region; otherwise matches the full ' +
          'page (body) text — so nav/header/footer phrases are found even when a large <main> ' +
          'is present. The `text` and `fullText` outputs are unaffected.',
      },
      {
        name: 'mask',
        type: 'array',
        description:
          'CSS selectors whose elements are masked (blacked out) in the screenshot — for pages ' +
          'that show secrets. Mirrors browser.screenshot\'s mask.',
      },
      {
        name: 'screenshot',
        type: 'boolean',
        description:
          'Set false to skip the screenshot entirely (no image artifact) — for sensitive pages. ' +
          'Default true. When false, the `screenshot` output field is also omitted — do not ' +
          'reference it from an outputMapping or the run fails with an Unresolved reference.',
      },
    ],
    outputs: [
      { name: 'url', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'text', type: 'string' },
      { name: 'truncated', type: 'boolean' },
      { name: 'elements', type: 'array' },
      { name: 'consoleErrors', type: 'object' },
      { name: 'screenshot', type: 'string', description: 'Path to the screenshot artifact. Absent when screenshot:false was passed.' },
      { name: 'fullText', type: 'string' },
      { name: 'settled', type: 'boolean' },
      { name: 'matched', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const p = page(ctx)
    const cap = ctx.capabilities.browser as BrowserCap

    const targetUrl = String(inputs.url)
    const maxChars = typeof inputs.maxChars === 'number' && inputs.maxChars > 0 ? inputs.maxChars : 2000
    const focusSel = inputs.focus ? String(inputs.focus) : null
    const waitForSel = inputs.waitFor ? String(inputs.waitFor) : null
    const expectStr = inputs.expect && typeof inputs.expect === 'string' ? inputs.expect : null
    // Coerce a lone non-empty string to a single-element list so callers who pass
    // mask: '#secret' (instead of mask: ['#secret']) are still masked. Without this
    // the non-array branch silently takes the else path and the screenshot is taken
    // unmasked — a secret leak.
    const maskList = Array.isArray(inputs.mask)
      ? inputs.mask
      : (typeof inputs.mask === 'string' && inputs.mask ? [inputs.mask] : undefined)
    const maskSelectors = maskList ? maskList.map((s) => p.locator(String(s))) : undefined
    const wantShot = inputs.screenshot !== false

    // Snapshot the console log entries themselves (by object identity) before
    // navigating so consoleErrors only reflects entries that arrive during THIS
    // navigation, not earlier steps that shared the same browser capability.
    // Using a Set of entry references (not an index) makes this survive cappedPush
    // evictions: once the shared buffer exceeds BUFFER_CAP (500) the oldest entry
    // is shift()-ed out, sliding every subsequent entry's index down by 1. An index
    // snapshot taken before eviction would then slice from the wrong position and
    // silently drop errors (or return [] → report 0 errors on a broken page).
    // Entry identity is stable across shift() — the object reference never changes.
    const consoleBefore = new Set(cap.consoleLog ?? [])

    // 1. Navigate. Use domcontentloaded (reliable) rather than networkidle, which
    // never fires on pages with a persistent connection (SSE / long-poll / analytics)
    // and would make a healthy page time out as "unreachable".
    await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    // Best-effort settle for late-rendered content; swallow a timeout (not fatal).
    try {
      await p.waitForLoadState('networkidle', { timeout: 5000 })
    } catch {
      // Persistent connections never reach networkidle — fine, read what's there.
    }

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
    let focusFound = true
    if (focusSel) {
      // Check DOM synchronously via evaluate — no auto-wait, no timeout hazard.
      // innerText(sel) waits for the element by default (Playwright auto-wait),
      // which would hang 30s on a missing selector even with timeout:0 (which
      // means "no timeout" in Playwright, not "fail immediately").
      const exists = await p.evaluate(
        `!!document.querySelector(${JSON.stringify(focusSel)})`,
      )
      if (exists) {
        fullText = await p.innerText(focusSel)
      } else {
        focusFound = false
        // Selector absent — fall back to main-content for the `text` output (still
        // useful perception), but the match below will NOT treat this as a hit.
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

    // 6. Console errors from the captured log, scoped to entries that arrived
    // after this navigation began (consoleBefore was captured before p.goto so
    // earlier steps sharing the same browser cap don't pollute this count).
    // Using Set membership (entry identity) rather than a sliced index so the
    // count is correct even when cappedPush has evicted entries from the front
    // of the shared buffer (shifting every index down).
    const errorEntries = (cap.consoleLog ?? []).filter((e) => !consoleBefore.has(e) && e.type === 'error')
    const consoleErrors = {
      count: errorEntries.length,
      sample: errorEntries.slice(0, 3).map((e) => e.text),
    }

    // 7. Screenshot → artifact (skipped when wantShot is false; masked when mask selectors given).
    let screenshotPath: string | undefined
    if (wantShot) {
      const buf = await p.screenshot(maskSelectors ? { mask: maskSelectors } : undefined)
      screenshotPath = ctx.artifacts.attach('web-read.png', buf, { kind: 'screenshot' })
    }

    // 8. Full text → artifact (save as Buffer/string; attach accepts both).
    const fullTextPath = ctx.artifacts.attach('web-read.txt', fullText, {
      mime: 'text/plain',
      kind: 'file',
    })

    // 9. Optional expect → matched boolean.
    // When focus is set we match against the already-extracted focus-region text
    // (fullText). When no focus is set we match against the FULL body innerText so
    // nav/header/footer phrases are found even when a large <main> is present and
    // would otherwise have been preferred by the main-content heuristic.
    let matched: boolean | undefined
    if (expectStr !== null) {
      if (focusSel) {
        // Focus region: a hit only if the selector actually resolved. A missing
        // focus selector means the scoped region never rendered — never a match.
        matched = focusFound ? fullText.includes(expectStr) : false
      } else {
        // No focus: match the FULL body text (bypass the main-content heuristic).
        try {
          matched = normalizeWhitespace(await p.innerText('body')).includes(expectStr)
        } catch {
          matched = fullText.includes(expectStr)
        }
      }
    }

    return {
      url: p.url(),
      title: await p.title(),
      text,
      truncated,
      elements,
      consoleErrors,
      ...(screenshotPath !== undefined ? { screenshot: screenshotPath } : {}),
      fullText: fullTextPath,
      settled,
      ...(matched !== undefined ? { matched } : {}),
    }
  },
)
