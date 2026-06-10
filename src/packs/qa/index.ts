import type { Pack } from '../../pack/types'
import { assertEquals, assertContains } from './assertions'
import { apiRequest } from './api'
import {
  browserCapability,
  browserGoto,
  browserClick,
  browserFill,
  browserTextVisible,
  browserExtractText,
  browserHtml,
  browserScreenshot,
} from './browser'

/**
 * QA pack — the first dogfood pack. Built-in primitive blocks an agent composes
 * into verification workflows. QA terminology stays inside the pack; the core
 * stays generic. The `browser` capability (Playwright) is set up per run only
 * when a workflow actually uses a browser block.
 */
export const qaPack: Pack = {
  name: 'qa',
  blocks: [
    assertEquals,
    assertContains,
    apiRequest,
    browserGoto,
    browserClick,
    browserFill,
    browserTextVisible,
    browserExtractText,
    browserHtml,
    browserScreenshot,
  ],
  capabilities: [browserCapability],
}
