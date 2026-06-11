import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { startDashboard } from './dashboard'
import { Runtime } from '../../core/runtime'
import { corePack } from '../../packs/core'
import type { BlockDefinition } from '../../core/types'

let ws: string
let server: http.Server
let base: string
let runId: string

beforeAll(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-dash-'))
  // Produce one real run with an artifact for the dashboard to show.
  const wf: BlockDefinition = {
    id: 'dash-fixture',
    name: 'Dash Fixture',
    version: '0.1.0',
    inputs: [],
    outputs: [],
    execution: {
      type: 'workflow',
      steps: [{ id: 'save', block: 'artifact.write', inputs: { name: 'note.txt', content: 'hello dash' } }],
      outputMapping: { artifact: '$save.artifact' },
    },
  }
  const record = await new Runtime(ws, [corePack]).run(wf, {})
  runId = record.runId
  server = await startDashboard(ws, 0)
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('aart dashboard (read-only local server)', () => {
  it('serves the page and the overview', async () => {
    const page = await fetch(base + '/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('aart dashboard')
    const overview = (await (await fetch(base + '/api/overview')).json()) as { workspace: string; initialized: boolean }
    expect(overview.workspace).toBe(ws)
    expect(overview.initialized).toBe(true)
  })

  it('lists blocks and runs', async () => {
    const blocks = (await (await fetch(base + '/api/blocks')).json()) as Array<{ id: string }>
    expect(blocks.map((b) => b.id)).toContain('browser.goto')
    const runs = (await (await fetch(base + '/api/runs')).json()) as Array<{
      runId: string
      status: string
    }>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId, status: 'COMPLETED' })
  })

  it('returns a run detail with artifact basenames, and serves the artifact', async () => {
    const run = (await (await fetch(`${base}/api/run?id=${runId}`)).json()) as {
      artifacts: string[]
      trace: unknown[]
    }
    expect(run.artifacts).toEqual(['note.txt'])
    expect(run.trace).toHaveLength(1)
    const art = await fetch(`${base}/artifact?run=${runId}&name=note.txt`)
    expect(art.status).toBe(200)
    expect(await art.text()).toBe('hello dash')
  })

  it('refuses traversal, bad ids, and writes', async () => {
    expect((await fetch(`${base}/artifact?run=${runId}&name=../run.json`)).status).toBe(404)
    expect((await fetch(`${base}/artifact?run=../evil&name=x`)).status).toBe(400)
    expect((await fetch(`${base}/api/run?id=../../etc`)).status).toBe(400)
    expect((await fetch(`${base}/api/run?id=00000000-aaaa-bbbb-cccc-000000000000`)).status).toBe(404)
    expect((await fetch(base + '/', { method: 'POST' })).status).toBe(405)
  })

  it('surfaces built-in packs in /api/packs', async () => {
    const packs = (await (await fetch(base + '/api/packs')).json()) as Array<{
      name: string
      kind: string
      status: string
      blocks: number
      capabilities: string[]
      aliases: string[]
    }>
    expect(packs.length).toBeGreaterThan(0)
    const core = packs.find((p) => p.name === 'core')
    expect(core).toBeDefined()
    expect(core!.kind).toBe('built-in')
    expect(core!.status).toBe('native')
    expect(core!.blocks).toBeGreaterThan(0)
    expect(core!.capabilities).toContain('browser')
    expect(core!.aliases.length).toBeGreaterThan(0)
  })

  it('reports initialized:false and empty runs for a fresh workspace', async () => {
    const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-dash-empty-'))
    let emptyServer: http.Server | undefined
    try {
      emptyServer = await startDashboard(emptyWs, 0)
      const emptyAddr = emptyServer.address()
      const emptyBase = `http://127.0.0.1:${typeof emptyAddr === 'object' && emptyAddr ? emptyAddr.port : 0}`
      const overview = (await (await fetch(emptyBase + '/api/overview')).json()) as {
        workspace: string
        initialized: boolean
      }
      expect(overview.workspace).toBe(emptyWs)
      expect(overview.initialized).toBe(false)
      const runs = (await (await fetch(emptyBase + '/api/runs')).json()) as unknown[]
      expect(runs).toEqual([])
    } finally {
      if (emptyServer) await new Promise<void>((r) => emptyServer!.close(() => r()))
      fs.rmSync(emptyWs, { recursive: true, force: true })
    }
  })
})
