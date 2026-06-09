import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { Runtime } from '../../core/runtime'
import { qaPack } from './index'
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

suite('qa.browser via Runtime (real Chromium)', () => {
  let server: http.Server
  let url: string

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
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
          { id: 'open', block: 'qa.browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'see', block: 'qa.browser.text_visible', inputs: { text: 'Dashboard' } },
          { id: 'shot', block: 'qa.browser.screenshot', inputs: { name: 'dash' } },
        ],
        outputMapping: { artifact: '$shot.artifact' },
      },
    }
    const record = await new Runtime(dir, [qaPack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')
    expect(record.artifacts.length).toBe(1)
    expect(fs.existsSync(record.artifacts[0]!)).toBe(true)
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
          { id: 'open', block: 'qa.browser.goto', inputs: { url: '{{inputs.url}}' } },
          { id: 'see', block: 'qa.browser.text_visible', inputs: { text: 'Nope', timeoutMs: 1000 } },
        ],
      },
    }
    const record = await new Runtime(dir, [qaPack]).run(wf, { url })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/Text not visible/)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30000)
})
