import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSecrets, redactRecord } from './secrets'
import { Runtime } from './runtime'
import { corePack } from '../packs/core'
import type { BlockDefinition, RunRecord } from './types'

describe('loadSecrets', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sec-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.AART_SECRET_TOKEN
  })

  it('reads .aa/secrets.json', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), JSON.stringify({ password: 'p' }))
    expect(loadSecrets(dir).password).toBe('p')
  })

  it('reads AART_SECRET_* env (lowercased), overriding the file', () => {
    process.env.AART_SECRET_TOKEN = 'envtok'
    expect(loadSecrets(dir).token).toBe('envtok')
  })

  it('lowercases file keys so env overrides a differently-cased file key', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), JSON.stringify({ TOKEN: 'fileval' }))
    process.env.AART_SECRET_TOKEN = 'envval'
    const s = loadSecrets(dir)
    expect(s.token).toBe('envval')
    expect(s.TOKEN).toBeUndefined()
  })
})

describe('redactRecord', () => {
  it('masks secret values everywhere, deep, skipping very short ones', () => {
    const rec = {
      runId: 'r',
      blockId: 'b',
      status: 'COMPLETED',
      inputs: { a: 'my-secret-value' },
      trace: [{ seq: 0, stepId: 's', block: 'b', status: 'COMPLETED', inputs: { x: 'pre my-secret-value post' }, startedAt: 'now' }],
      results: { r: 'my-secret-value', keep: 'ab' },
      snapshot: { root: {} as BlockDefinition, blocks: {} },
      artifacts: [],
      startedAt: 'now',
    } as unknown as RunRecord
    const out = redactRecord(rec, { p: 'my-secret-value', short: 'ab' })
    expect(JSON.stringify(out)).not.toContain('my-secret-value')
    expect((out.results as Record<string, unknown>).r).toBe('***')
    expect((out.trace[0]!.inputs as Record<string, unknown>).x).toBe('pre *** post')
    // short secrets (< 4 chars) are not redacted, to avoid mangling text
    expect((out.results as Record<string, unknown>).keep).toBe('ab')
  })

  it('masks a longer secret fully even when a shorter secret is its prefix', () => {
    const rec = { results: { x: 'token is abcdef here' } } as unknown as RunRecord
    const out = redactRecord(rec, { a: 'abcd', b: 'abcdef' })
    expect((out.results as Record<string, unknown>).x).toBe('token is *** here')
  })

  it('masks the JSON-escaped form of a secret (e.g. reflected in an api body)', () => {
    const secret = 'a"b\\c-secret'
    const escaped = JSON.stringify(secret).slice(1, -1) // a\"b\\c-secret
    const rec = { results: { body: `{"echo":"${escaped}"}` } } as unknown as RunRecord
    const out = redactRecord(rec, { p: secret })
    expect(JSON.stringify(out)).not.toContain(escaped)
  })
})

describe('secrets in a workflow (resolve at run time, redact in report)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-secrun-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.AART_SECRET_PASSWORD
  })

  it('resolves {{secrets.x}} for the block but redacts it from the record', async () => {
    process.env.AART_SECRET_PASSWORD = 'supersecret123'
    const wf: BlockDefinition = {
      id: 'sec-wf',
      name: 'Secret WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          // assert passes ONLY if the real secret value flowed into the block
          { id: 'check', block: 'assert.equals', inputs: { actual: '{{secrets.password}}', expected: 'supersecret123' } },
        ],
        outputMapping: { pw: '{{secrets.password}}' },
      },
    }
    const rec = await new Runtime(dir, [corePack]).run(wf, {})
    expect(rec.status).toBe('COMPLETED') // real value reached the assertion
    expect(rec.results).toEqual({ pw: '***' }) // but it's redacted in the report
    expect(JSON.stringify(rec)).not.toContain('supersecret123')
  })
})
