/**
 * Tests for the new primitive blocks and the http.health-check workflow.
 *
 * Sections:
 *   1. http.check unit tests (with local http server)
 *   2. assert.jsonpath unit tests
 *   3. report.summarize unit tests
 *   4. http.health-check end-to-end workflow test
 *   5. Polling proof — http.check + flow.sleep + if/next polling pattern
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../../core/context'
import { ArtifactStore } from '../../artifacts/artifact-store'
import { Runtime } from '../../core/runtime'
import { corePack } from './index'
import { httpCheck } from './http-check'
import { assertJsonpath } from './assert-jsonpath'
import { reportSummarize } from './report-summarize'
import { renderDefinition } from '../../agent/render'
import { httpHealthCheck } from './workflows'
import { resolveInputs, type ResolveScope } from '../../core/resolver'
import type { BlockDefinition } from '../../core/types'
import type { ExecutionContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

function makeCtx(dir: string): ExecutionContext {
  return createContext({ workspace: dir, artifacts: new ArtifactStore(path.join(dir, 'run')) })
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aart-health-'))
}

// ---------------------------------------------------------------------------
// 1. http.check
// ---------------------------------------------------------------------------

describe('http.check', () => {
  let server: http.Server
  let baseUrl: string
  let dir: string
  let ctx: ExecutionContext

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.url === '/error') {
        res.statusCode = 500
        res.end('Internal Server Error')
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  beforeEach(() => {
    dir = tmpDir()
    ctx = makeCtx(dir)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('200 response → ok:true, status:200, latencyMs >= 0, body contains content', async () => {
    const out = await httpCheck.run(ctx, { url: `${baseUrl}/ok` })
    expect(out.ok).toBe(true)
    expect(out.status).toBe(200)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
    expect(String(out.body)).toContain('ok')
    expect(out.error).toBe('')
  })

  it('500 response → ok:false, status:500, does NOT throw', async () => {
    const out = await httpCheck.run(ctx, { url: `${baseUrl}/error` })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(500)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
    // Must not throw — non-matching status is captured, not raised
  })

  it('expectStatus:500 on /error → ok:true', async () => {
    const out = await httpCheck.run(ctx, { url: `${baseUrl}/error`, expectStatus: 500 })
    expect(out.ok).toBe(true)
    expect(out.status).toBe(500)
  })

  it('unreachable port → ok:false, status:0, error set, does NOT throw', async () => {
    // Use a port that is almost certainly closed (different from our server).
    const out = await httpCheck.run(ctx, { url: 'http://127.0.0.1:1', timeoutMs: 1000 })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(0)
    expect(typeof out.error).toBe('string')
    expect(String(out.error).length).toBeGreaterThan(0)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('uses default method=GET and default expectStatus=200', async () => {
    // Omit method and expectStatus — defaults kick in.
    const out = await httpCheck.run(ctx, { url: `${baseUrl}/ok` })
    expect(out.ok).toBe(true)
  })

  // Fix #3: output must include the probed `url` field so two failures with the
  // same status are distinguishable in report.summarize.
  it('output includes the input url on a successful probe', async () => {
    const out = await httpCheck.run(ctx, { url: `${baseUrl}/ok` })
    expect(out.url).toBe(`${baseUrl}/ok`)
  })

  it('output includes the input url when the probe fails (bad status)', async () => {
    const out = await httpCheck.run(ctx, { url: `${baseUrl}/error` })
    expect(out.ok).toBe(false)
    expect(out.url).toBe(`${baseUrl}/error`)
  })

  it('output includes the input url when the probe fails (unreachable)', async () => {
    const out = await httpCheck.run(ctx, { url: 'http://127.0.0.1:1', timeoutMs: 1000 })
    expect(out.ok).toBe(false)
    expect(out.url).toBe('http://127.0.0.1:1')
  })

  // Fix #2: the abort timer must stay armed through the body read.
  // A server that sends headers then stalls the body must yield ok:false with a
  // timeout error — NOT hang forever.
  it('stalled body (headers sent but body never finishes) → ok:false timeout error within timeoutMs', async () => {
    // Create a server that sends headers AND a partial body chunk, then hangs
    // without ever calling res.end().  This causes fetch() to resolve (headers
    // received) while res.text() blocks on the unfinished body — so only an
    // armed abort controller can unblock it.  A test that used writeHead-only
    // without flushing any bytes would let fetch() itself hang (never resolving),
    // and the abort would land on fetch() rather than on res.text() — meaning
    // it would pass even if the timer were cleared right after fetch().
    const stalledServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('partial')
      // Deliberately never call res.end() — body read blocks here forever.
    })
    await new Promise<void>((r) => stalledServer.listen(0, '127.0.0.1', r))
    const addr = stalledServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const stalledUrl = `http://127.0.0.1:${port}/stall`

    const timeoutMs = 300 // short timeout so the test completes quickly
    const t0 = Date.now()
    let out: Record<string, unknown>
    try {
      out = await httpCheck.run(ctx, { url: stalledUrl, timeoutMs })
    } finally {
      await new Promise<void>((r) => stalledServer.close(() => r()))
    }
    const elapsed = Date.now() - t0

    // Must resolve (not hang), and within a reasonable bound of the timeout.
    expect(elapsed).toBeLessThan(timeoutMs + 1500)
    expect(out!.ok).toBe(false)
    expect(String(out!.error)).toMatch(/timeout/)
    expect(out!.url).toBe(stalledUrl)
  })

  // Round-2 fix: a NON-timeout body-read failure (premature connection close)
  // must also yield ok:false — a response whose body we cannot read is not healthy.
  it('body read failure (premature close, not a timeout) → ok:false', async () => {
    const brokenServer = http.createServer((_req, res) => {
      // Promise 100 bytes, send a few, then abruptly destroy the socket so
      // res.text() rejects with a premature-close error (not an abort).
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('partial')
      res.socket?.destroy()
    })
    await new Promise<void>((r) => brokenServer.listen(0, '127.0.0.1', r))
    const addr = brokenServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const brokenUrl = `http://127.0.0.1:${port}/broken`

    let out: Record<string, unknown>
    try {
      // Generous timeout so the failure is the body read, not the abort timer.
      out = await httpCheck.run(ctx, { url: brokenUrl, timeoutMs: 5000 })
    } finally {
      await new Promise<void>((r) => brokenServer.close(() => r()))
    }
    expect(out!.ok).toBe(false)
    expect(String(out!.error)).not.toBe('') // a body error was recorded
    expect(String(out!.error)).not.toMatch(/timeout/) // and it was NOT the abort/timeout path
    expect(out!.url).toBe(brokenUrl)
  })

  // Round-3 fix #1: a large body is streamed and truncated at the cap (10000),
  // not buffered whole.
  it('truncates a large response body to the cap (does not buffer the whole body)', async () => {
    const big = 'x'.repeat(50_000)
    const bigServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(big)
    })
    await new Promise<void>((r) => bigServer.listen(0, '127.0.0.1', r))
    const addr = bigServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    let out: Record<string, unknown>
    try {
      out = await httpCheck.run(ctx, { url: `http://127.0.0.1:${port}/big` })
    } finally {
      await new Promise<void>((r) => bigServer.close(() => r()))
    }
    expect(out!.ok).toBe(true)
    expect((out!.body as string).length).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// 2. assert.jsonpath
// ---------------------------------------------------------------------------

describe('assert.jsonpath', () => {
  const ctx = makeCtx(os.tmpdir())

  it('extracts a nested value by dot-path', async () => {
    const data = { a: { b: { c: 42 } } }
    const out = await assertJsonpath.run(ctx, { data, path: 'a.b.c' })
    expect(out.value).toBe(42)
    expect(out.ok).toBe(true)
  })

  it('returns undefined for a missing path without throwing (no expected, no exists)', async () => {
    const out = await assertJsonpath.run(ctx, { data: { x: 1 }, path: 'x.y.z' })
    expect(out.value).toBeUndefined()
    expect(out.ok).toBe(true)
  })

  it('equality assertion passes when values match', async () => {
    const data = { status: 'healthy', count: 3 }
    const out = await assertJsonpath.run(ctx, { data, path: 'status', expected: 'healthy' })
    expect(out.value).toBe('healthy')
    expect(out.ok).toBe(true)
  })

  it('equality assertion throws on mismatch', async () => {
    const data = { status: 'degraded' }
    await expect(assertJsonpath.run(ctx, { data, path: 'status', expected: 'healthy' })).rejects.toThrow(
      /Assertion failed/,
    )
  })

  it('exists:true throws when value is undefined', async () => {
    const data = { a: 1 }
    await expect(assertJsonpath.run(ctx, { data, path: 'b', exists: true })).rejects.toThrow(
      /does not exist/,
    )
  })

  it('exists:true passes when value is present (even falsy)', async () => {
    const data = { a: 0 }
    const out = await assertJsonpath.run(ctx, { data, path: 'a', exists: true })
    expect(out.value).toBe(0)
    expect(out.ok).toBe(true)
  })

  it('auto-parses a JSON string input', async () => {
    const json = JSON.stringify({ health: { ok: true } })
    const out = await assertJsonpath.run(ctx, { data: json, path: 'health.ok' })
    expect(out.value).toBe(true)
  })

  it('throws a clear error on non-JSON string input', async () => {
    await expect(assertJsonpath.run(ctx, { data: 'not json', path: 'a' })).rejects.toThrow(
      /not valid JSON/,
    )
  })

  it('deep equality assertion (objects)', async () => {
    const data = { meta: { x: 1, y: 2 } }
    const out = await assertJsonpath.run(ctx, { data, path: 'meta', expected: { y: 2, x: 1 } })
    expect(out.value).toEqual({ x: 1, y: 2 })
    expect(out.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. report.summarize
// ---------------------------------------------------------------------------

describe('report.summarize', () => {
  let dir: string
  let ctx: ExecutionContext

  beforeEach(() => {
    dir = tmpDir()
    ctx = makeCtx(dir)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('mixed results → correct counts, ok=false, summary lines', async () => {
    const results = [
      { ok: true, url: 'https://a.com', status: 200 },
      { ok: false, url: 'https://b.com', status: 503, error: 'timeout' },
      { ok: true, url: 'https://c.com', status: 200 },
    ]
    const out = await reportSummarize.run(ctx, { results, title: 'Test Report' })
    expect(out.total).toBe(3)
    expect(out.passed).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.ok).toBe(false)
    expect(String(out.summary)).toContain('Test Report')
    expect(String(out.summary)).toContain('FAIL')
    expect(String(out.summary)).toContain('PASS')
  })

  it('all-pass → ok=true', async () => {
    const results = [
      { ok: true, url: 'https://x.com', status: 200 },
      { ok: true, url: 'https://y.com', status: 200 },
    ]
    const out = await reportSummarize.run(ctx, { results })
    expect(out.ok).toBe(true)
    expect(out.total).toBe(2)
    expect(out.passed).toBe(2)
    expect(out.failed).toBe(0)
  })

  it('unwraps {items:[...]} shape from a forEach step output', async () => {
    const forEachOutput = {
      items: [
        { ok: true, url: 'https://a.com' },
        { ok: false, url: 'https://b.com' },
      ],
    }
    const out = await reportSummarize.run(ctx, { results: forEachOutput })
    expect(out.total).toBe(2)
    expect(out.passed).toBe(1)
    expect(out.failed).toBe(1)
  })

  it('artifact is attached when writeArtifact=true (default)', async () => {
    const results = [{ ok: true, url: 'https://a.com' }]
    await reportSummarize.run(ctx, { results, title: 'Artifact Test' })
    const items = ctx.artifacts.list()
    const report = items.find((a) => a.name === 'health-summary.md')
    expect(report).toBeDefined()
    expect(report!.mime).toBe('text/markdown')
    const content = fs.readFileSync(report!.path, 'utf8')
    expect(content).toContain('Artifact Test')
  })

  it('artifact has kind="report" (not the generic "file" default)', async () => {
    const results = [{ ok: true, url: 'https://a.com' }]
    await reportSummarize.run(ctx, { results, title: 'Kind Test' })
    const items = ctx.artifacts.list()
    const report = items.find((a) => a.name === 'health-summary.md')
    expect(report).toBeDefined()
    expect(report!.kind).toBe('report')
  })

  it('does NOT attach artifact when writeArtifact=false', async () => {
    const results = [{ ok: true }]
    await reportSummarize.run(ctx, { results, writeArtifact: false })
    const items = ctx.artifacts.list()
    expect(items.find((a) => a.name === 'health-summary.md')).toBeUndefined()
  })

  it('custom okKey works correctly', async () => {
    const results = [{ healthy: true }, { healthy: false }, { healthy: true }]
    const out = await reportSummarize.run(ctx, { results, okKey: 'healthy', writeArtifact: false })
    expect(out.passed).toBe(2)
    expect(out.failed).toBe(1)
  })

  // Round-5 fix #4: an empty result set must NOT report healthy (e.g. an empty or
  // miswired http.health-check endpoint list would otherwise show ALL PASSED).
  it('empty result set is NOT a pass (ok=false, NO RESULTS)', async () => {
    const out = await reportSummarize.run(ctx, { results: [], writeArtifact: false })
    expect(out.total).toBe(0)
    expect(out.failed).toBe(0)
    expect(out.ok).toBe(false)
    expect(String(out.summary)).toContain('NO RESULTS')
  })

  // Fix #3: two failures with the same status must produce DISTINCT summary lines
  // when http.check now includes `url` in its output.  This verifies that
  // report.summarize renders url= per row and the two rows are distinguishable.
  it('two same-status failures produce distinct lines (url discriminates them)', async () => {
    const results = [
      { ok: false, url: 'https://a.example.com', status: 503, error: '' },
      { ok: false, url: 'https://b.example.com', status: 503, error: '' },
    ]
    const out = await reportSummarize.run(ctx, { results, writeArtifact: false })
    const summary = String(out.summary)
    expect(summary).toContain('url=https://a.example.com')
    expect(summary).toContain('url=https://b.example.com')
    // Ensure the two lines are distinct (the url field makes them different)
    const failLines = summary.split('\n').filter((l) => l.includes('[FAIL]'))
    expect(failLines).toHaveLength(2)
    expect(failLines[0]).not.toBe(failLines[1])
  })

  // Round-3 fix #4: a string "false" must count as a failure, not a pass.
  it('counts a string "false" okKey as a failure (strict boolean pass)', async () => {
    const results = [{ ok: 'false' }, { ok: true }, { ok: 'true' }]
    const out = await reportSummarize.run(ctx, { results, writeArtifact: false })
    expect(out.total).toBe(3)
    expect(out.passed).toBe(2) // boolean true + string "true"; the string "false" fails
    expect(out.failed).toBe(1)
    expect(out.ok).toBe(false)
  })

  // Round-3 fix #7: a non-array results shape must fail loudly, not coerce to an
  // empty (zero-failure) success.
  it('throws on a non-array results shape (no false "0 failures" pass)', async () => {
    await expect(reportSummarize.run(ctx, { results: { not: 'an array' } })).rejects.toThrow(/must be an array/)
  })

  // Round-3 fix #3: secret values must be redacted from the summary AND the
  // artifact file (artifact contents are not covered by run-record redaction).
  it('redacts secret values from the summary and artifact', async () => {
    const secretCtx = createContext({
      workspace: dir,
      artifacts: new ArtifactStore(path.join(dir, 'secret-run')),
      secrets: { token: 'SUPERSECRET' },
    })
    const results = [{ ok: false, url: 'https://api/health?token=SUPERSECRET', status: 500, error: '' }]
    const out = await reportSummarize.run(secretCtx, { results })
    expect(String(out.summary)).not.toContain('SUPERSECRET')
    const report = secretCtx.artifacts.list().find((a) => a.name === 'health-summary.md')
    expect(report).toBeDefined()
    expect(fs.readFileSync(report!.path, 'utf8')).not.toContain('SUPERSECRET')
  })
})

// ---------------------------------------------------------------------------
// 4. http.health-check end-to-end workflow
// ---------------------------------------------------------------------------

describe('http.health-check workflow (e2e)', () => {
  let server: http.Server
  let baseUrl: string
  let dir: string

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/healthy') {
        res.statusCode = 200
        res.end('ok')
        return
      }
      if (req.url === '/degraded') {
        res.statusCode = 503
        res.end('unavailable')
        return
      }
      if (req.url === '/also-healthy') {
        res.statusCode = 200
        res.end('fine')
        return
      }
      res.statusCode = 404
      res.end('nope')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  beforeEach(() => {
    dir = tmpDir()
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('runs end-to-end with 2 healthy + 1 unhealthy endpoint; ok=false, counts correct', async () => {
    const rt = new Runtime(dir, [corePack])
    const def = rt.registry.getBlock('http.health-check')
    expect(def).toBeDefined()
    expect(def!.approval).toBe('approved')

    const record = await rt.run(def!, {
      endpoints: [
        { url: `${baseUrl}/healthy` },
        { url: `${baseUrl}/degraded` },
        { url: `${baseUrl}/also-healthy` },
      ],
    })

    expect(record.status).toBe('COMPLETED')
    expect(record.results).toBeDefined()

    const { ok, total, passed, failed, report } = record.results as {
      ok: boolean
      total: number
      passed: number
      failed: number
      report: string
    }

    expect(total).toBe(3)
    expect(passed).toBe(2)
    expect(failed).toBe(1)
    expect(ok).toBe(false)
    expect(report).toContain('Health Check')
    expect(report).toContain('PASS')
    expect(report).toContain('FAIL')

    // Artifact must be present in the run record
    const artifact = record.artifacts.find((a) => a.name === 'health-summary.md')
    expect(artifact).toBeDefined()
    expect(artifact!.mime).toBe('text/markdown')
    const artifactContent = fs.readFileSync(artifact!.path, 'utf8')
    expect(artifactContent).toContain('Health Check')
    expect(artifactContent).toBe(report)

    // Must run WITHOUT --yes (pre-approved pack workflow)
    // Verify that unapprovedInTree returns empty — i.e. no approval gate required.
    // The fact that rt.run succeeded without opts.approved=true confirms this.
    // (Runtime defaults opts.approved to true anyway, but the approval stamp matters for CLI gating.)
  })

  it('all healthy → ok=true', async () => {
    const rt = new Runtime(dir, [corePack])
    const def = rt.registry.getBlock('http.health-check')!
    const record = await rt.run(def, {
      endpoints: [{ url: `${baseUrl}/healthy` }, { url: `${baseUrl}/also-healthy` }],
    })
    expect(record.status).toBe('COMPLETED')
    const { ok, total, passed, failed } = record.results as {
      ok: boolean
      total: number
      passed: number
      failed: number
    }
    expect(ok).toBe(true)
    expect(total).toBe(2)
    expect(passed).toBe(2)
    expect(failed).toBe(0)
  })

  it('timeoutMs: 9000 arrives at the probe step as the NUMBER 9000 (not string "9000")', () => {
    // Resolve only the timeoutMs field from the probe step's inputs, using
    // the same resolver the engine calls. This confirms '$inputs.timeoutMs' is
    // type-preserving; the old '{{inputs.timeoutMs}}' would produce the string "9000".
    const probeStep = httpHealthCheck.execution.type === 'workflow'
      ? httpHealthCheck.execution.steps.find((s) => s.id === 'probe')
      : undefined
    expect(probeStep).toBeDefined()

    const scope: ResolveScope = {
      inputs: { endpoints: [], timeoutMs: 9000 },
      steps: {},
      // Provide a loopVar so url: '{{ep.url}}' also resolves (needed for resolveInputs).
      loopVar: { name: 'ep', value: { url: 'http://example.com' } },
      loopIndex: 0,
    }
    const resolved = resolveInputs(probeStep!.inputs as Record<string, unknown>, scope)
    // Must be the number 9000, not the string "9000"
    expect(typeof resolved.timeoutMs).toBe('number')
    expect(resolved.timeoutMs).toBe(9000)
  })

  it('renderDefinition output shows forEach step for the workflow', () => {
    const rendered = renderDefinition(httpHealthCheck)
    expect(rendered).toContain('http.health-check')
    expect(rendered).toContain('workflow')
    expect(rendered).toContain('forEach')
    expect(rendered).toContain('probe')
    expect(rendered).toContain('summary')
    // Log it for the required return value in the task spec:
    console.log('\n=== renderDefinition(http.health-check) ===\n' + rendered + '\n===\n')
  })

  // Fix #4: endpoints input must be declared as type 'array', not 'object'.
  // The forEach expression resolves the array and would fail a type-check or
  // mislead callers who read the catalog.
  it('http.health-check declares endpoints input type as "array"', () => {
    const endpointsField = httpHealthCheck.inputs.find((f) => f.name === 'endpoints')
    expect(endpointsField).toBeDefined()
    expect(endpointsField!.type).toBe('array')
  })
})

// ---------------------------------------------------------------------------
// 5. Polling proof — http.check + flow.sleep + if/next polling loop
//
// A workflow polls a server that returns 503 for the first N calls then 200.
// Without outputMapping, the workflow's default output equals the LAST EXECUTED
// step's output — which must be the probe step (http.check result on success),
// NOT the sleep step.
// ---------------------------------------------------------------------------

describe('polling proof (default output = last EXECUTED step)', () => {
  let server: http.Server
  let baseUrl: string
  let dir: string
  let callCount: number

  beforeAll(async () => {
    callCount = 0
    server = http.createServer((_req, res) => {
      callCount++
      if (callCount <= 2) {
        // First two calls return 503
        res.statusCode = 503
        res.end('not ready')
      } else {
        // Third call onwards returns 200
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
    dir = tmpDir()
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('polls until 200; default output equals the successful probe output, not sleep output', async () => {
    // Workflow:
    //   probe  → http.check (expectStatus 200)
    //   nap    → flow.sleep (if probe.ok is false, sleep and loop back to probe)
    //
    // Control flow:
    //   probe: if '$probe.ok === true' → exit (then: undefined = null → done)
    //           else → nap
    //   nap:   next: 'probe'  (always loop back)
    //
    // No outputMapping → results = last executed step's output.
    // On success the last executed step is 'probe' (nap is skipped by the if exit).
    // So results must have ok:true, status:200 (http.check's output shape).

    const wf: BlockDefinition = {
      id: 'poll-until-ok',
      name: 'Poll Until OK',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'probe',
            block: 'http.check',
            inputs: { url: '{{inputs.url}}', expectStatus: 200, timeoutMs: 3000 },
            if: '$probe.ok === true',
            // then: undefined → null → workflow exits
            else: 'nap',
          },
          {
            id: 'nap',
            block: 'flow.sleep',
            inputs: { ms: 20 },
            next: 'probe',
          },
        ],
        // Deliberately NO outputMapping — tests default-last-executed-step path
      },
    }

    const rt = new Runtime(dir, [corePack])
    const record = await rt.run(wf, { url: `${baseUrl}/poll` }, undefined, { approved: true })

    expect(record.status).toBe('COMPLETED')

    // Server was called at least 3 times (2 failures + 1 success)
    expect(callCount).toBeGreaterThanOrEqual(3)

    // Trace: probe, nap, probe, nap, probe (the last probe exits)
    // The last step id in trace must be 'probe', not 'nap'
    const lastStep = record.trace[record.trace.length - 1]
    expect(lastStep?.stepId).toBe('probe')

    // Default output must be probe's output (http.check shape), NOT nap's (flow.sleep shape)
    // http.check outputs: ok, status, latencyMs, body, error
    // flow.sleep outputs: sleptMs
    expect(record.results).toBeDefined()
    const results = record.results as Record<string, unknown>
    expect(results.ok).toBe(true)
    expect(results.status).toBe(200)
    expect(results.latencyMs).toBeGreaterThanOrEqual(0)
    // Must NOT have sleptMs (which would be flow.sleep's output)
    expect(results.sleptMs).toBeUndefined()
  })
})
