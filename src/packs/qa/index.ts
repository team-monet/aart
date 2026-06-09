import type { BlockDefinition } from '../../core/types'

/**
 * QA pack — the first dogfood pack (Phase 3). A pack is a set of built-in
 * blocks plus the capabilities they need (here: `browser` via Playwright, and
 * `http` for the api blocks). QA terminology lives ONLY inside the pack; the
 * core stays generic (no QABlock / TestContext / BrowserEngine in core).
 *
 * The initial primitive blocks (hand-written; AI composes workflows from them):
 *   qa.browser.goto      qa.browser.click      qa.browser.fill
 *   qa.browser.text_visible   qa.browser.screenshot
 *   qa.api.request       qa.assert.equals      qa.assert.contains
 *
 * These are declared here as a manifest; their executors land in browser.ts /
 * api.ts / assertions.ts once the capability/sandbox model is in place.
 */

export interface PackManifest {
  name: string
  capabilities: string[]
  blockIds: string[]
}

export const qaPack: PackManifest = {
  name: 'qa',
  capabilities: ['browser', 'http'],
  blockIds: [
    'qa.browser.goto',
    'qa.browser.click',
    'qa.browser.fill',
    'qa.browser.text_visible',
    'qa.browser.screenshot',
    'qa.api.request',
    'qa.assert.equals',
    'qa.assert.contains',
  ],
}

/** Phase 3: return the built-in QA block definitions for registration. */
export function qaBlocks(): BlockDefinition[] {
  throw new Error('qaBlocks not implemented — Phase 3 (requires Playwright + capability model)')
}
