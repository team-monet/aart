import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../../core/context'
import { ArtifactStore } from '../../artifacts/artifact-store'
import { Runtime } from '../../core/runtime'
import { qaPack } from './index'
import { assertEquals, assertContains } from './assertions'
import { apiRequest } from './api'
import type { BlockDefinition } from '../../core/types'

function ctxIn(dir: string) {
  return createContext({
    runId: 't',
    workspace: dir,
    artifacts: new ArtifactStore(path.join(dir, 'a')),
  })
}

describe('qa.assert', () => {
  const ctx = ctxIn(os.tmpdir())
  it('equals passes on equal values and throws otherwise', async () => {
    expect(await assertEquals.run(ctx, { actual: 200, expected: 200 })).toEqual({ ok: true })
    await expect(assertEquals.run(ctx, { actual: 1, expected: 2 })).rejects.toThrow(/Assertion failed/)
  })
  it('contains works for strings and arrays', async () => {
    expect(await assertContains.run(ctx, { value: 'hello world', item: 'world' })).toEqual({ ok: true })
    expect(await assertContains.run(ctx, { value: [1, 2, 3], item: 2 })).toEqual({ ok: true })
    await expect(assertContains.run(ctx, { value: 'abc', item: 'z' })).rejects.toThrow(/does not contain/)
  })
})

describe('qa.api + Runtime (native execution end to end)', () => {
  let server: http.Server
  let url: string
  let dir: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hello: 'world', path: req.url }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    url = `http://127.0.0.1:${port}/ping`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-qa-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('apiRequest returns status, ok and parsed body', async () => {
    const out = await apiRequest.run(ctxIn(dir), { url })
    expect(out.status).toBe(200)
    expect(out.ok).toBe(true)
    expect((out.body as { hello: string }).hello).toBe('world')
  })

  it('runs an api -> assert workflow green via the Runtime', async () => {
    const wf: BlockDefinition = {
      id: 'api-smoke',
      name: 'API Smoke',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'call', block: 'qa.api.request', inputs: { url: '{{inputs.url}}' } },
          { id: 'check', block: 'qa.assert.equals', inputs: { actual: '$call.status', expected: 200 } },
        ],
        outputMapping: { status: '$call.status', hello: '$call.body.hello' },
      },
    }
    const record = await new Runtime(dir, [qaPack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')
    expect(record.results).toEqual({ status: 200, hello: 'world' })
    expect(record.trace.map((t) => t.status)).toEqual(['COMPLETED', 'COMPLETED'])
  })

  it('fails the run (not crash) when an assertion fails', async () => {
    const wf: BlockDefinition = {
      id: 'api-bad',
      name: 'API Bad',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'call', block: 'qa.api.request', inputs: { url: '{{inputs.url}}' } },
          { id: 'check', block: 'qa.assert.equals', inputs: { actual: '$call.status', expected: 500 } },
        ],
      },
    }
    const record = await new Runtime(dir, [qaPack]).run(wf, { url })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/Assertion failed/)
    expect(record.trace[1]!.status).toBe('FAILED')
  })
})
