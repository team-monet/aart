import type { Pack } from '../../pack/types'
import { assertEquals, assertContains } from './assertions'
import { apiRequest, httpDownload } from './api'
import { dataParse, dataStringify } from './data'
import { flowSleep, flowFail } from './flow'
import { fileRead, fileWrite } from './file'
import { artifactWrite } from './artifacts'
import {
  browserCapability,
  browserGoto,
  browserClick,
  browserFill,
  browserTextVisible,
  browserExtractText,
  browserHtml,
  browserEval,
  browserSnapshot,
  browserBack,
  browserScreenshot,
} from './browser'

/**
 * Core pack — the built-in primitives every automation composes from: browser
 * (Playwright), HTTP, and assertions. Domain terminology stays out of the
 * runtime core. The `browser` capability is set up per run only when a
 * workflow actually uses a browser block.
 *
 * This pack was originally named `qa`; the old `qa.*` block ids remain valid
 * forever via `legacyAliases` so registered workflows never break.
 */
export const corePack: Pack = {
  name: 'core',
  blocks: [
    assertEquals,
    assertContains,
    apiRequest,
    httpDownload,
    dataParse,
    dataStringify,
    flowSleep,
    flowFail,
    fileRead,
    fileWrite,
    artifactWrite,
    browserGoto,
    browserClick,
    browserFill,
    browserTextVisible,
    browserExtractText,
    browserHtml,
    browserEval,
    browserSnapshot,
    browserBack,
    browserScreenshot,
  ],
  capabilities: [browserCapability],
  aliases: {
    'qa.api.request': 'http.request',
    'qa.assert.equals': 'assert.equals',
    'qa.assert.contains': 'assert.contains',
    'qa.browser.goto': 'browser.goto',
    'qa.browser.click': 'browser.click',
    'qa.browser.fill': 'browser.fill',
    'qa.browser.text_visible': 'browser.text_visible',
    'qa.browser.extract_text': 'browser.extract_text',
    'qa.browser.html': 'browser.html',
    'qa.browser.eval': 'browser.eval',
    'qa.browser.screenshot': 'browser.screenshot',
  },
}
