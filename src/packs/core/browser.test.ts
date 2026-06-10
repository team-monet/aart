import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { Runtime } from '../../core/runtime'
import {
  approveWorkspacePack,
  loadApprovedPacks,
  mergePacks,
  registerWorkspacePack,
} from '../../pack/loader'
import { corePack } from './index'
import type { BlockDefinition } from '../../core/types'

// Self-skip when the Chromium binary isn't installed, so the suite stays green
// without it. Run `npx playwright install chromium` to enable these.
let hasBrowser = false
try {
  hasBrowser = fs.existsSync(chromium.executablePath())
} catch {
  hasBrowser = false
}
const suite = hasBrowser ? describe : describe.skip

suite('browser.* via Runtime (real Chromium)', () => {
  let server: http.Server
  let url: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      if (req.url === '/js') {
        // Content that exists only after JavaScript runs — what extract_text must see.
        res.end(
          '<html><body><div id="app"></div>' +
            "<script>document.getElementById('app').textContent = 'Hydrated Content'</script>" +
            '</body></html>',
        )
        return
      }
      res.end('<html><body><h1>Dashboard</h1><input name="email" /></body></html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('navigates, asserts visible text, and captures a screenshot artifact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-br-'))
    const wf: BlockDefinition = {
      id: 'browser-smoke',
      name: 'Browser Smoke',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'open', block: 'browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'see', block: 'browser.text_visible', inputs: { text: 'Dashboard' } },
          { id: 'shot', block: 'browser.screenshot', inputs: { name: 'dash' } },
        ],
        outputMapping: { artifact: '$shot.artifact' },
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')
    expect(record.artifacts.length).toBe(1)
    expect(fs.existsSync(record.artifacts[0]!)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('extracts rendered (post-JavaScript) text and HTML into the data flow', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-br-'))
    const wf: BlockDefinition = {
      id: 'browser-read',
      name: 'Browser Read',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'open', block: 'browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'text', block: 'browser.extract_text', inputs: {} },
          { id: 'html', block: 'browser.html', inputs: { maxChars: 10 } },
        ],
        outputMapping: {
          text: '$text.text',
          textTruncated: '$text.truncated',
          html: '$html.html',
          htmlTruncated: '$html.truncated',
        },
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { url: `${url}js` })
    expect(record.status).toBe('COMPLETED')
    // The text exists only after the page's script ran — proves we read the rendered DOM.
    expect(record.results?.text).toContain('Hydrated Content')
    expect(record.results?.textTruncated).toBe(false)
    expect(String(record.results?.html)).toHaveLength(10)
    expect(record.results?.htmlTruncated).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('evaluates expressions in the page context (counts, attributes)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-br-'))
    const wf: BlockDefinition = {
      id: 'browser-eval',
      name: 'Browser Eval',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'open', block: 'browser.goto', inputs: { url: '{{inputs.url}}' } },
          {
            id: 'count',
            block: 'browser.eval',
            inputs: { expression: 'document.querySelectorAll("h1").length' },
          },
          {
            id: 'attr',
            block: 'browser.eval',
            inputs: { expression: 'document.querySelector("input").getAttribute("name")' },
          },
        ],
        outputMapping: { count: '$count.result', attr: '$attr.result' },
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')
    expect(record.results).toEqual({ count: 1, attr: 'email' })
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('an agent-authored workspace pack block shares the built-in browser session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-br-'))
    // The self-serve path: the agent writes its own browser block as a pack —
    // declaring the BUILT-IN `browser` capability — registers it (no execution),
    // the user approves, and it drives the same page browser.goto opened.
    const packDir = path.join(dir, '.aa', 'packs', 'mytools')
    fs.mkdirSync(packDir, { recursive: true })
    fs.writeFileSync(
      path.join(packDir, 'index.js'),
      `module.exports = {
        name: 'mytools',
        blocks: [{
          def: {
            id: 'mytools.heading',
            name: 'Heading',
            version: '0.1.0',
            capabilities: ['browser'],
            inputs: [],
            outputs: [{ name: 'heading', type: 'string' }],
          },
          run: async (ctx) => ({
            heading: await ctx.capabilities.browser.page.evaluate(
              'document.querySelector("h1").textContent',
            ),
          }),
        }],
        capabilities: [],
      }`,
    )
    registerWorkspacePack(dir, 'mytools')
    approveWorkspacePack(dir, 'mytools')
    const merged = mergePacks([corePack], loadApprovedPacks(dir).packs)
    expect(merged.warnings).toEqual([])

    const wf: BlockDefinition = {
      id: 'self-serve-read',
      name: 'Self Serve Read',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'open', block: 'browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'read', block: 'mytools.heading', inputs: {} },
        ],
        outputMapping: { heading: '$read.heading' },
      },
    }
    const record = await new Runtime(dir, merged.packs).run(wf, { url })
    expect(record.status).toBe('COMPLETED')
    // Same session: the pack block saw the page the BUILT-IN goto navigated.
    expect(record.results?.heading).toBe('Dashboard')
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('caps oversized eval results with a clear error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-br-'))
    const wf: BlockDefinition = {
      id: 'browser-eval-big',
      name: 'Browser Eval Big',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'open', block: 'browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'big', block: 'browser.eval', inputs: { expression: '"x".repeat(300000)' } },
        ],
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/result too large/)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('fails the run when expected text is not visible', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-br-'))
    const wf: BlockDefinition = {
      id: 'browser-miss',
      name: 'Browser Miss',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'open', block: 'browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'see', block: 'browser.text_visible', inputs: { text: 'Nope', timeoutMs: 1000 } },
        ],
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/Text not visible/)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)
})
