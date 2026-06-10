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
    id: 'qa.browser.goto',
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
    id: 'qa.browser.click',
    name: 'Browser: Click',
    version: '0.1.0',
    description: 'Click the element matching a selector.',
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
    id: 'qa.browser.fill',
    name: 'Browser: Fill',
    version: '0.1.0',
    description: 'Fill an input matching a selector with a value.',
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
    id: 'qa.browser.text_visible',
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
    id: 'qa.browser.extract_text',
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
    id: 'qa.browser.html',
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

export const browserScreenshot = nativeBlock(
  {
    id: 'qa.browser.screenshot',
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
