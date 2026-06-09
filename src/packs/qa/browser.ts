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
  screenshot: () => Promise<Buffer>
  getByText: (text: string) => {
    first: () => { waitFor: (o: { state: string; timeout: number }) => Promise<void> }
  }
}

export const browserCapability: Capability = {
  name: 'browser',
  async setup() {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
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
    const timeout = typeof inputs.timeoutMs === 'number' ? inputs.timeoutMs : 5000
    try {
      await page(ctx).getByText(String(inputs.text)).first().waitFor({ state: 'visible', timeout })
    } catch {
      throw new Error(`Text not visible: ${inputs.text}`)
    }
    return { visible: true }
  },
)

export const browserScreenshot = nativeBlock(
  {
    id: 'qa.browser.screenshot',
    name: 'Browser: Screenshot',
    version: '0.1.0',
    description: 'Capture a screenshot and attach it to the run as an artifact.',
    capabilities: ['browser'],
    inputs: [{ name: 'name', type: 'string', required: true }],
    outputs: [{ name: 'artifact', type: 'string' }],
  },
  async (ctx, inputs) => {
    const buf = await page(ctx).screenshot()
    const file = ctx.artifacts.attach(`${inputs.name}.png`, buf)
    return { artifact: file }
  },
)
