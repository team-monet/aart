import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkDependencies, checkHostNodeSyntax, runHostNodeBlock } from './host-runner'
import { createContext } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { Runtime } from './runtime'
import type { BlockDefinition } from './types'
import type { ExecutionContext } from './context'

let ws: string
let ctx: ExecutionContext

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-host-'))
  ctx = createContext({
    workspace: ws,
    artifacts: new ArtifactStore(path.join(ws, 'artifacts')),
    vars: { greeting: 'hi' },
  })
})
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }))

describe('checkDependencies', () => {
  it('accepts registry names, ranges, scopes, and node built-ins', () => {
    expect(
      checkDependencies(['lodash', 'lodash@^4.17.0', '@scope/pkg@>=1 <2', 'node:fs', 'node:fs/promises']),
    ).toEqual([])
  })

  it('rejects non-registry sources and malformed names', () => {
    for (const bad of [
      'file:../evil',
      'git+https://example.com/x.git',
      'pkg@github:user/repo',
      'pkg@npm:other@1', // alias smuggling (colon)
      '../evil',
      'UPPERCASE',
      'lodash; rm -rf /',
    ]) {
      expect(checkDependencies([bad]), bad).not.toEqual([])
    }
  })
})

describe('checkHostNodeSyntax', () => {
  it('accepts valid code and rejects syntax errors without running anything', () => {
    expect(checkHostNodeSyntax('return { ok: require("node:path").sep }')).toBeNull()
    expect(checkHostNodeSyntax('return {')).toMatch(/./)
  })
})

describe('runHostNodeBlock (real subprocess, node: built-ins only — no npm)', () => {
  it('runs with require of built-ins, captures console, passes ctx', async () => {
    const res = await runHostNodeBlock(
      `const p = require('node:path')
       console.log('joining for run', ctx.runId)
       return { joined: p.join('a', 'b'), greeting: ctx.vars.greeting, n: inputs.n + 1 }`,
      ['node:path'],
      { n: 41 },
      ctx,
    )
    expect(res.output).toEqual({ joined: path.join('a', 'b'), greeting: 'hi', n: 42 })
    expect(res.logs.some((l) => l.includes('joining for run'))).toBe(true)
  })

  it('user code printing to stdout cannot corrupt the result channel', async () => {
    const res = await runHostNodeBlock(
      `process.stdout.write('{"ok":false,"garbage":true}')
       return { fine: true }`,
      ['node:path'],
      {},
      ctx,
    )
    expect(res.output).toEqual({ fine: true })
    expect(res.logs.some((l) => l.includes('garbage'))).toBe(true)
  })

  it('propagates thrown errors', async () => {
    await expect(
      runHostNodeBlock(`throw new Error('boom')`, ['node:path'], {}, ctx),
    ).rejects.toThrow(/boom/)
  })

  it('rejects a non-JSON-serializable return', async () => {
    await expect(
      runHostNodeBlock(`const a = {}; a.self = a; return a`, ['node:path'], {}, ctx),
    ).rejects.toThrow(/serializable|circular/i)
  })

  it('kills a runaway block at the timeout', async () => {
    await expect(
      runHostNodeBlock(`while (true) {}`, ['node:path'], {}, ctx, { timeoutMs: 600 }),
    ).rejects.toThrow(/timed out/)
  }, 10000)

  it('fails clearly when a required module is not declared/installed', async () => {
    await expect(
      runHostNodeBlock(`require('definitely-not-installed-xyz')`, ['node:path'], {}, ctx),
    ).rejects.toThrow(/Cannot find module/)
  })
})

describe('engine dispatch via Runtime', () => {
  it('routes a dependency-bearing node block to the host tier', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-host-rt-'))
    const def: BlockDefinition = {
      id: 'hash-it',
      name: 'Hash It',
      version: '0.1.0',
      inputs: [{ name: 'text', type: 'string', required: true }],
      outputs: [{ name: 'sha256', type: 'string' }],
      execution: {
        type: 'node',
        dependencies: ['node:crypto'],
        code: `const { createHash } = require('node:crypto')
               return { sha256: createHash('sha256').update(inputs.text).digest('hex') }`,
      },
    }
    const record = await new Runtime(dir, []).run(def, { text: 'aart' })
    expect(record.status).toBe('COMPLETED')
    expect(record.results?.sha256).toMatch(/^[0-9a-f]{64}$/)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('sandboxed node blocks (no deps) still cannot require anything', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-host-rt-'))
    const def: BlockDefinition = {
      id: 'no-escape',
      name: 'No Escape',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: `return { r: typeof require }` },
    }
    const record = await new Runtime(dir, []).run(def, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.results?.r).toBe('undefined')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// Real npm install — network. Opt in with AART_NPM_TEST=1.
const npmIt = process.env.AART_NPM_TEST ? it : it.skip
describe('npm-installed dependencies', () => {
  npmIt('installs a registry package and requires it (cached on second run)', async () => {
    const res = await runHostNodeBlock(
      `const leftPad = require('left-pad'); return { padded: leftPad('7', 3, '0') }`,
      ['left-pad@1.3.0'],
      {},
      ctx,
      { timeoutMs: 60_000 },
    )
    expect(res.output).toEqual({ padded: '007' })
    const again = await runHostNodeBlock(
      `return { padded: require('left-pad')('8', 3, '0') }`,
      ['left-pad@1.3.0'],
      {},
      ctx,
      { timeoutMs: 10_000 },
    )
    expect(again.output).toEqual({ padded: '008' })
  }, 120_000)
})
