import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../../core/context'
import { ArtifactStore } from '../../artifacts/artifact-store'
import { Runtime } from '../../core/runtime'
import { corePack } from './index'
import { dataParse, dataStringify } from './data'
import { flowSleep, flowFail } from './flow'
import { fileRead, fileWrite } from './file'
import { httpDownload } from './api'
import type { BlockDefinition } from '../../core/types'
import type { ExecutionContext } from '../../core/context'

let dir: string
let ctx: ExecutionContext

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-basics-'))
  ctx = createContext({ workspace: dir, artifacts: new ArtifactStore(path.join(dir, 'run')) })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('data.parse / data.stringify', () => {
  it('parses json and yaml', async () => {
    expect(await dataParse.run(ctx, { text: '{"a":1}', format: 'json' })).toEqual({ value: { a: 1 } })
    expect(await dataParse.run(ctx, { text: 'a: 1\nb:\n  - x\n', format: 'yaml' })).toEqual({
      value: { a: 1, b: ['x'] },
    })
  })

  it('parses csv into objects via the header row (and raw rows on demand)', async () => {
    const csv = 'name,note\nalpha,"says ""hi"", twice"\nbeta,plain\n'
    expect(await dataParse.run(ctx, { text: csv, format: 'csv' })).toEqual({
      value: [
        { name: 'alpha', note: 'says "hi", twice' },
        { name: 'beta', note: 'plain' },
      ],
    })
    const raw = (await dataParse.run(ctx, { text: 'a,b\n1,2', format: 'csv', csvHeader: false })) as {
      value: string[][]
    }
    expect(raw.value).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('stringifies json (pretty + compact), yaml, and csv round-trips', async () => {
    expect(await dataStringify.run(ctx, { value: { a: 1 }, format: 'json', pretty: false })).toEqual({
      text: '{"a":1}',
    })
    const pretty = (await dataStringify.run(ctx, { value: { a: 1 }, format: 'json' })) as { text: string }
    expect(pretty.text).toContain('\n  "a": 1')

    const rows = [
      { name: 'alpha', note: 'says "hi", twice' },
      { name: 'beta', note: 'plain' },
    ]
    const csv = (await dataStringify.run(ctx, { value: rows, format: 'csv' })) as { text: string }
    expect(await dataParse.run(ctx, { text: csv.text, format: 'csv' })).toEqual({ value: rows })
  })

  it('rejects unknown formats and bad json', async () => {
    await expect(dataParse.run(ctx, { text: 'x', format: 'toml' })).rejects.toThrow(/unknown format/)
    await expect(dataParse.run(ctx, { text: '{nope', format: 'json' })).rejects.toThrow()
  })
})

describe('flow.sleep / flow.fail', () => {
  it('sleeps for the requested time', async () => {
    const start = Date.now()
    expect(await flowSleep.run(ctx, { ms: 60 })).toEqual({ sleptMs: 60 })
    expect(Date.now() - start).toBeGreaterThanOrEqual(55)
  })

  it('rejects sleeps beyond the cap and invalid values', async () => {
    await expect(flowSleep.run(ctx, { ms: 10 ** 9 })).rejects.toThrow(/cap/)
    await expect(flowSleep.run(ctx, { ms: -5 })).rejects.toThrow(/invalid/)
  })

  it('fail fails the run with the given message at the end of a branch', async () => {
    await expect(flowFail.run(ctx, { message: 'deploy not healthy' })).rejects.toThrow('deploy not healthy')
    const wf: BlockDefinition = {
      id: 'branch-fail',
      name: 'Branch Fail',
      version: '0.1.0',
      inputs: [{ name: 'n', type: 'number' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          {
            id: 'check',
            block: 'assert.equals',
            inputs: { actual: 1, expected: 1 },
            if: 'inputs.n > 3',
            then: 'done',
            else: 'bad',
          },
          { id: 'done', block: 'assert.equals', inputs: { actual: 1, expected: 1 } },
          { id: 'bad', block: 'flow.fail', inputs: { message: 'n was too small' } },
        ],
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { n: 1 })
    expect(record.status).toBe('FAILED')
    expect(record.error).toBe('n was too small')
  })
})

describe('file.read / file.write (workspace-scoped)', () => {
  it('write → read round-trip, creating parent dirs', async () => {
    const w = (await fileWrite.run(ctx, { path: 'out/notes/today.md', content: '# hi\n' })) as {
      path: string
      bytes: number
    }
    expect(w.path).toBe(path.join('out', 'notes', 'today.md'))
    expect(w.bytes).toBe(5)
    expect(await fileRead.run(ctx, { path: 'out/notes/today.md' })).toEqual({
      text: '# hi\n',
      truncated: false,
    })
  })

  it('clamps reads at maxChars', async () => {
    await fileWrite.run(ctx, { path: 'big.txt', content: 'x'.repeat(100) })
    expect(await fileRead.run(ctx, { path: 'big.txt', maxChars: 10 })).toEqual({
      text: 'x'.repeat(10),
      truncated: true,
    })
  })

  it('rejects workspace escapes and .aa (secrets live there)', async () => {
    await expect(fileRead.run(ctx, { path: '../outside.txt' })).rejects.toThrow(/escapes the workspace/)
    await expect(fileRead.run(ctx, { path: '.aa/secrets.json' })).rejects.toThrow(/not allowed/)
    await expect(fileWrite.run(ctx, { path: '.aa/registry/x.json', content: '{}' })).rejects.toThrow(
      /not allowed/,
    )
    await expect(fileWrite.run(ctx, { path: 'safe/../../esc.txt', content: 'x' })).rejects.toThrow(
      /escapes the workspace/,
    )
  })
})

describe('http.download + artifact.write + report-generation e2e', () => {
  let server: http.Server
  let url: string
  const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x01]) // binary-ish

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/file.bin') {
        res.setHeader('content-type', 'application/octet-stream')
        res.end(payload)
        return
      }
      if (req.url === '/data.json') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ items: [{ name: 'alpha' }, { name: 'beta' }] }))
        return
      }
      res.statusCode = 404
      res.end('nope')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('downloads bytes to an artifact; fails on 404 and on oversize', async () => {
    const out = (await httpDownload.run(ctx, { url: `${url}/file.bin`, name: 'file.bin' })) as {
      artifact: string
      bytes: number
      status: number
    }
    expect(out.status).toBe(200)
    expect(out.bytes).toBe(payload.byteLength)
    expect(fs.readFileSync(out.artifact)).toEqual(payload)

    await expect(httpDownload.run(ctx, { url: `${url}/missing`, name: 'x' })).rejects.toThrow(/HTTP 404/)
    await expect(
      httpDownload.run(ctx, { url: `${url}/file.bin`, name: 'x', maxBytes: 3 }),
    ).rejects.toThrow(/too large/)
  })

  it('e2e: fetch JSON → reshape → stringify CSV → artifact.write (a report-producing workflow)', async () => {
    const wf: BlockDefinition = {
      id: 'mini-report',
      name: 'Mini Report',
      version: '0.1.0',
      inputs: [{ name: 'url', type: 'string' }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'fetch', block: 'http.request', inputs: { url: '{{inputs.url}}/data.json' } },
          { id: 'csv', block: 'data.stringify', inputs: { value: '$fetch.body.items', format: 'csv' } },
          { id: 'save', block: 'artifact.write', inputs: { name: 'report.csv', content: '$csv.text' } },
        ],
        outputMapping: { artifact: '$save.artifact' },
      },
    }
    const record = await new Runtime(dir, [corePack]).run(wf, { url })
    expect(record.status).toBe('COMPLETED')
    const artifact = String(record.results?.artifact)
    expect(record.artifacts.map((a) => a.path)).toContain(artifact)
    expect(fs.readFileSync(artifact, 'utf8')).toBe('name\nalpha\nbeta')
  })
})
