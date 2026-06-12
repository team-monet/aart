import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRun, readRun, listRuns, runDir } from './report'
import type { RunRecord } from './types'

function mkRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'r1',
    blockId: 'demo',
    status: 'RUNNING',
    approved: true,
    inputs: {},
    trace: [],
    snapshot: { root: {} as never, blocks: {} },
    artifacts: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('two-phase write + resilient reads', () => {
  let ws: string
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aart-2p-')))
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('writeRun is atomic — leaves no .tmp behind', async () => {
    await writeRun(ws, mkRecord({ runId: 'a' }))
    const dir = runDir(ws, 'a')
    expect(fs.existsSync(path.join(dir, 'run.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'run.json.tmp'))).toBe(false)
  })

  it('a persisted RUNNING record (crash before terminal) reads back as RUNNING and lists', async () => {
    await writeRun(ws, mkRecord({ runId: 'b', status: 'RUNNING' }))
    expect((await readRun(ws, 'b')).status).toBe('RUNNING')
    const runs = await listRuns(ws, 10)
    expect(runs.find((r) => r.runId === 'b')?.status).toBe('RUNNING')
  })

  it('readRun degrades a truncated/unparseable run.json to a one-row stub (never throws)', async () => {
    const dir = runDir(ws, 'c')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'run.json'), '{ "runId": "c", "blockId": "x"') // truncated
    const rec = await readRun(ws, 'c')
    expect(rec.runId).toBe('c')
    expect(rec.status).toBe('FAILED')
    expect(rec.trace).toEqual([])
  })

  it('readRun degrades a parseable-but-invalid record, preserving blockId/status', async () => {
    const dir = runDir(ws, 'd')
    fs.mkdirSync(dir, { recursive: true })
    // valid JSON, but missing required fields (inputs/trace/snapshot/startedAt)
    fs.writeFileSync(
      path.join(dir, 'run.json'),
      JSON.stringify({ runId: 'd', blockId: 'demo', status: 'RUNNING' }),
    )
    const rec = await readRun(ws, 'd')
    expect(rec.runId).toBe('d')
    expect(rec.blockId).toBe('demo')
    expect(rec.status).toBe('RUNNING')
    expect(rec.trace).toEqual([])
  })

  it('readRun still rejects (ENOENT) for a missing run', async () => {
    await expect(readRun(ws, 'missing')).rejects.toThrow()
  })

  it('a valid terminal record round-trips, artifacts normalized', async () => {
    await writeRun(
      ws,
      mkRecord({
        runId: 'e',
        status: 'COMPLETED',
        endedAt: '2026-01-01T00:00:01.000Z',
        artifacts: [{ name: 'p.txt', path: '/x/p.txt', mime: 'text/plain', bytes: 3, kind: 'file' }],
      }),
    )
    const rec = await readRun(ws, 'e')
    expect(rec.status).toBe('COMPLETED')
    expect(rec.endedAt).toBe('2026-01-01T00:00:01.000Z')
    expect(rec.artifacts[0]).toMatchObject({ name: 'p.txt', kind: 'file' })
  })

  it('a legacy run.json with artifacts:string[] still reads (coerced to objects)', async () => {
    const dir = runDir(ws, 'f')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'run.json'),
      JSON.stringify(mkRecord({ runId: 'f', status: 'COMPLETED', endedAt: '2026-01-01T00:00:01.000Z' })).replace(
        '"artifacts":[]',
        '"artifacts":["/abs/note.txt"]',
      ),
    )
    const rec = await readRun(ws, 'f')
    expect(rec.artifacts[0]).toMatchObject({ name: 'note.txt', path: '/abs/note.txt', kind: 'file' })
  })
})
