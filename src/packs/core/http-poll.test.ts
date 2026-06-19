/**
 * Tests for http.poll:
 *   1. Catalog check — block appears with category and example
 *   2. E2E poll — server flips from 503 to 200 after a fixed count;
 *      asserts the poll loops (probe→wait→probe…), stops on the first
 *      healthy probe, runs WITHOUT --yes (pre-approved), and the mapped
 *      output is the successful probe's (ok:true, status:200).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../../core/runtime'
import { corePack } from './index'
import { httpPoll } from './http-poll'
import { buildCatalog } from '../../agent/catalog'
import { FileRegistry } from '../../registry/file-registry'

// ---------------------------------------------------------------------------
// 1. Catalog check
// ---------------------------------------------------------------------------

describe('http.poll catalog entry', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-poll-cat-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('appears in the catalog with category "http" and an example', () => {
    const rt = new Runtime(dir, [corePack])
    const catalog = buildCatalog(rt.registry)
    const entry = catalog.find((e) => e.id === 'http.poll')
    expect(entry).toBeDefined()
    expect(entry!.category).toBe('http')
    expect(entry!.example).toBeDefined()
    expect(entry!.example!.description).toBeTruthy()
    expect(entry!.example!.inputs).toBeDefined()
  })

  it('is stamped approved (pre-approved pack workflow)', () => {
    const rt = new Runtime(dir, [corePack])
    const def = rt.registry.getBlock('http.poll')
    expect(def).toBeDefined()
    expect(def!.approval).toBe('approved')
  })
})

// ---------------------------------------------------------------------------
// 2. E2E poll: server flips from 503 to 200 after a fixed count
// ---------------------------------------------------------------------------

describe('http.poll e2e — loops then stops on success', () => {
  let server: http.Server
  let baseUrl: string
  let dir: string
  let callCount: number
  // The server returns 503 for the first FAIL_COUNT calls, then 200.
  const FAIL_COUNT = 2

  beforeAll(async () => {
    callCount = 0
    server = http.createServer((_req, res) => {
      callCount++
      if (callCount <= FAIL_COUNT) {
        res.statusCode = 503
        res.end('not ready yet')
      } else {
        res.statusCode = 200
        res.end('ready')
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  beforeEach(() => {
    callCount = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-poll-e2e-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('polls until healthy; output is the successful probe result (ok:true, status:200)', async () => {
    const rt = new Runtime(dir, [corePack])
    const def = rt.registry.getBlock('http.poll')
    expect(def).toBeDefined()

    // Run without explicit approved:true — the workflow is pre-approved via the pack.
    // Runtime defaults opts.approved to true anyway, but the real gate is that
    // the block definition carries approval:'approved' from the pack loader.
    const record = await rt.run(def!, {
      url: `${baseUrl}/health`,
      expectStatus: 200,
      timeoutMs: 3000,
      delayMs: 10, // short delay so the test runs fast
    })

    expect(record.status).toBe('COMPLETED')

    // The server was called FAIL_COUNT times with 503, then once with 200.
    // So callCount must be exactly FAIL_COUNT + 1.
    expect(callCount).toBe(FAIL_COUNT + 1)

    // Trace: probe(503), wait, probe(503), wait, probe(200) → stop
    // The last trace entry must be 'probe', not 'wait'.
    const lastTrace = record.trace[record.trace.length - 1]
    expect(lastTrace).toBeDefined()
    expect(lastTrace!.stepId).toBe('probe')
    expect(lastTrace!.status).toBe('COMPLETED')

    // outputMapping maps probe's outputs → workflow outputs.
    expect(record.results).toBeDefined()
    const results = record.results as Record<string, unknown>
    expect(results.ok).toBe(true)
    expect(results.status).toBe(200)
    expect(typeof results.latencyMs).toBe('number')
    expect(results.latencyMs).toBeGreaterThanOrEqual(0)
    // body is the string 'ready'
    expect(String(results.body)).toBe('ready')

    // Must NOT expose flow.sleep internals (sleptMs)
    expect(results.sleptMs).toBeUndefined()
  })

  it('trace shows the probe→wait loop before the successful probe', async () => {
    const rt = new Runtime(dir, [corePack])
    const def = rt.registry.getBlock('http.poll')!

    const record = await rt.run(def, {
      url: `${baseUrl}/health`,
      expectStatus: 200,
      timeoutMs: 3000,
      delayMs: 10,
    })

    expect(record.status).toBe('COMPLETED')

    // Expected trace: probe(503), wait, probe(503), wait, probe(200)
    // = FAIL_COUNT probe+wait pairs + 1 final probe
    const stepIds = record.trace.map((t) => t.stepId)
    // There should be FAIL_COUNT 'wait' steps and FAIL_COUNT+1 'probe' steps
    const probeCount = stepIds.filter((id) => id === 'probe').length
    const waitCount = stepIds.filter((id) => id === 'wait').length
    expect(probeCount).toBe(FAIL_COUNT + 1)
    expect(waitCount).toBe(FAIL_COUNT)
  })
})
