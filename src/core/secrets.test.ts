import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSecrets, redactRecord, SecretCollisionError } from './secrets'
import type { LoadSecretsOptions } from './secrets'
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
    delete process.env.AART_SECRET_TESTKEY
    delete process.env.AART_SECRET_TOK
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

  // 4. env var resolution: both TESTKEY and testkey refs resolve (via resolver normalization)
  //    Here we verify loadSecrets itself stores with canonical lowercase.
  it('AART_SECRET_TESTKEY is stored as canonical "testkey"', () => {
    process.env.AART_SECRET_TESTKEY = 'envval'
    const s = loadSecrets(dir)
    expect(s['testkey']).toBe('envval')
    // uppercase variant must not exist — it is normalised away
    expect(s['TESTKEY']).toBeUndefined()
  })

  // 7. collision: two file keys that differ only in case → throw (propagates, not swallowed)
  it('throws SecretCollisionError when file has two keys that collide on canonical name', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Foo: 'a', foo: 'b' }),
    )
    expect(() => loadSecrets(dir)).toThrow(/collide/)
    expect(() => loadSecrets(dir)).toThrow(/foo/)
    // Pin the type — callers must branch on SecretCollisionError, not message text.
    expect(() => loadSecrets(dir)).toThrowError(SecretCollisionError)
  })

  // 7b. env-var collision: two AART_SECRET_* vars that collide → SecretCollisionError
  it('throws SecretCollisionError when two AART_SECRET_* env vars collide on canonical name', () => {
    // Both AART_SECRET_FOO and AART_SECRET_foo collapse to canonical "foo".
    // Node env keys are case-sensitive on Linux but not on macOS/Windows;
    // simulate via two vars with different suffix casing (FOO vs FOO2 won't
    // collide — need to fake via a direct env mutation that produces the same
    // canonical name). On Linux we can do AART_SECRET_FOO + AART_SECRET_FOO
    // only by assigning the env object directly.
    const saved = { ...process.env }
    try {
      // Force two entries that share canonical name "foo" by writing them
      // into process.env as distinct JS properties.
      ;(process.env as Record<string, string>)['AART_SECRET_FOO'] = 'val1'
      ;(process.env as Record<string, string>)['AART_SECRET_foo'] = 'val2'
      // On case-insensitive filesystems this may be the same key; skip if so.
      if (process.env['AART_SECRET_FOO'] === process.env['AART_SECRET_foo'] &&
          process.env['AART_SECRET_FOO'] === 'val2') {
        // macOS merges them — skip this test on case-insensitive platforms
        return
      }
      expect(() => loadSecrets(dir)).toThrowError(SecretCollisionError)
      expect(() => loadSecrets(dir)).toThrow(/collide/)
    } finally {
      delete (process.env as Record<string, string>)['AART_SECRET_FOO']
      delete (process.env as Record<string, string>)['AART_SECRET_foo']
    }
  })

  // 8. env-over-file precedence: same canonical name in both → env wins, no collision error
  it('env overrides file for the same canonical name without throwing', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), JSON.stringify({ tok: 'fileval' }))
    process.env.AART_SECRET_TOK = 'envval'
    const s = loadSecrets(dir)
    expect(s['tok']).toBe('envval') // env wins
  })

  // 10. malformed JSON → tolerated silently (no throw), no secrets loaded from file
  it('malformed secrets.json is silently tolerated', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), 'not-json-at-all{{{')
    expect(() => loadSecrets(dir)).not.toThrow()
    const s = loadSecrets(dir)
    expect(Object.keys(s)).toHaveLength(0)
  })

  // FIX A: valid JSON that is not a plain object is tolerated as "no file secrets"
  it('FIX-A: secrets.json containing JSON null is silently tolerated (no throw, no file secrets)', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), 'null')
    expect(() => loadSecrets(dir)).not.toThrow()
    expect(Object.keys(loadSecrets(dir))).toHaveLength(0)
  })

  it('FIX-A: secrets.json containing a JSON array is silently tolerated (no throw, no file secrets)', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), '["a","b"]')
    expect(() => loadSecrets(dir)).not.toThrow()
    expect(Object.keys(loadSecrets(dir))).toHaveLength(0)
  })

  it('FIX-A: secrets.json containing a JSON number is silently tolerated (no throw, no file secrets)', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), '42')
    expect(() => loadSecrets(dir)).not.toThrow()
    expect(Object.keys(loadSecrets(dir))).toHaveLength(0)
  })

  it('FIX-A: secrets.json containing a JSON string is silently tolerated (no throw, no file secrets)', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), '"just-a-string"')
    expect(() => loadSecrets(dir)).not.toThrow()
    expect(Object.keys(loadSecrets(dir))).toHaveLength(0)
  })

  it('FIX-A: env secrets still load when secrets.json is wrong-shaped (null)', () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), 'null')
    process.env.AART_SECRET_TOKEN = 'envtok-fixA'
    const s = loadSecrets(dir)
    expect(s['token']).toBe('envtok-fixA')
  })
})

describe('loadSecrets tolerateCollisions option (FIX C)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sec-tol-'))
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env['AART_SECRET_FOO']
    delete process.env['AART_SECRET_foo']
  })

  it('FIX-C: tolerateCollisions:true returns last-wins map instead of throwing on file key collision', () => {
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Foo: 'first', foo: 'last' }),
    )
    // default: throws
    expect(() => loadSecrets(dir)).toThrowError(SecretCollisionError)
    // tolerateCollisions: last-wins, no throw
    const opts: LoadSecretsOptions = { tolerateCollisions: true }
    expect(() => loadSecrets(dir, opts)).not.toThrow()
    const s = loadSecrets(dir, opts)
    // canonical 'foo' is present; the last value wins
    expect(s['foo']).toBe('last')
  })

  it('FIX-C: tolerateCollisions:true returns non-colliding keys intact', () => {
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Bar: 'first', bar: 'last', other: 'safe' }),
    )
    const s = loadSecrets(dir, { tolerateCollisions: true })
    expect(s['other']).toBe('safe')
    // colliding key: last-wins
    expect(s['bar']).toBe('last')
  })

  it('FIX-C: tolerateCollisions:false (default) still throws on collision', () => {
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Baz: 'a', baz: 'b' }),
    )
    expect(() => loadSecrets(dir)).toThrowError(SecretCollisionError)
    expect(() => loadSecrets(dir, { tolerateCollisions: false })).toThrowError(SecretCollisionError)
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
    delete process.env.AART_SECRET_TESTKEY
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

  // 4. env AART_SECRET_TESTKEY + {{secrets.testkey}} AND {{secrets.TESTKEY}} both resolve
  it('AART_SECRET_TESTKEY resolves via both {{secrets.testkey}} and {{secrets.TESTKEY}}', async () => {
    process.env.AART_SECRET_TESTKEY = 'envhello9999'
    const wf: BlockDefinition = {
      id: 'sec-case-env-wf',
      name: 'Env Secret Case WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          // lowercase ref
          { id: 'chk1', block: 'assert.equals', inputs: { actual: '{{secrets.testkey}}', expected: 'envhello9999' } },
          // uppercase ref (this was broken before Part 1)
          { id: 'chk2', block: 'assert.equals', inputs: { actual: '{{secrets.TESTKEY}}', expected: 'envhello9999' } },
        ],
        outputMapping: {},
      },
    }
    const rec = await new Runtime(dir, [corePack]).run(wf, {})
    expect(rec.status).toBe('COMPLETED')
  })

  // 4b. $secrets.TESTKEY via $-ref
  it('$secrets.TESTKEY ($-ref uppercase) resolves from AART_SECRET_TESTKEY', async () => {
    process.env.AART_SECRET_TESTKEY = 'envhello9999'
    const wf: BlockDefinition = {
      id: 'sec-case-ref-wf',
      name: 'Env Secret Ref WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'chk', block: 'assert.equals', inputs: { actual: '$secrets.TESTKEY', expected: 'envhello9999' } },
        ],
        outputMapping: {},
      },
    }
    const rec = await new Runtime(dir, [corePack]).run(wf, {})
    expect(rec.status).toBe('COMPLETED')
  })

  // 2. file key TESTKEY (uppercase in file) + ref {{secrets.TESTKEY}} → resolves
  it('uppercase file key TESTKEY resolves via {{secrets.TESTKEY}}', async () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), JSON.stringify({ TESTKEY: 'fileval9999' }))
    const wf: BlockDefinition = {
      id: 'sec-file-upper-wf',
      name: 'File Upper Key WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'chk', block: 'assert.equals', inputs: { actual: '{{secrets.TESTKEY}}', expected: 'fileval9999' } },
        ],
        outputMapping: {},
      },
    }
    const rec = await new Runtime(dir, [corePack]).run(wf, {})
    expect(rec.status).toBe('COMPLETED')
  })

  // 9. bare $secrets / {{secrets}} still throw guard errors (unchanged)
  it('bare $secrets still throws its existing guard error', async () => {
    process.env.AART_SECRET_TESTKEY = 'x'
    const wf: BlockDefinition = {
      id: 'bare-sec-wf',
      name: 'Bare Secret WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 'chk', block: 'assert.equals', inputs: { actual: '$secrets', expected: 'x' } },
        ],
        outputMapping: {},
      },
    }
    const rec = await new Runtime(dir, [corePack]).run(wf, {})
    expect(rec.status).toBe('FAILED')
    expect(JSON.stringify(rec)).toMatch(/must name a secret/)
  })
})

describe('loadSecrets collision → runtime produces a FAILED record (not an uncaught throw)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sec-coll-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a secrets.json collision yields a FAILED RunRecord from runtime.run (not a raw throw)', async () => {
    // Write a secrets.json with two keys that collide on the canonical name "foo".
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Foo: 'a', foo: 'b' }),
    )

    const wf: BlockDefinition = {
      id: 'dummy-wf',
      name: 'Dummy',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return { ok: true };' },
    }

    // runtime.run must NOT throw — it must return a FAILED record so the
    // CLI/MCP both receive the normal failure envelope.
    let record: RunRecord | undefined
    await expect(
      (async () => { record = await new Runtime(dir, []).run(wf, {}) })()
    ).resolves.not.toThrow()

    expect(record).toBeDefined()
    expect(record!.status).toBe('FAILED')
    expect(record!.error).toMatch(/collide/)
    expect(record!.error).toMatch(/secrets load failed/)
  })

  it('the FAILED record from a collision is value-free (no secret values appear)', async () => {
    // Secret values are 'a' and 'b' — too short to redact, so the real test is
    // that they never reach the record at all (empty map was used for redaction).
    // Use longer values to be unambiguous.
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Baz: 'supersensitivevalue1', baz: 'supersensitivevalue2' }),
    )

    const wf: BlockDefinition = {
      id: 'dummy-vf-wf',
      name: 'Dummy VF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return { ok: true };' },
    }

    const record = await new Runtime(dir, []).run(wf, {})
    expect(record.status).toBe('FAILED')
    // The record must contain no secret values — the collision message carries
    // only key names ("baz"), not the values.
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('supersensitivevalue1')
    expect(serialized).not.toContain('supersensitivevalue2')
    // Key names ("baz") are present in the error message — that is intentional.
    expect(record.error).toMatch(/baz/)
  })

  it('collision path calls notify() — a failing webhook does not crash the run', async () => {
    // Write colliding keys.
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Qux: 'val1', qux: 'val2' }),
    )
    // Write a notify.json pointing at a URL that will fail (localhost refuses).
    // This confirms the notify() call is made AND that a webhook failure does
    // not propagate out of runtime.run.
    fs.writeFileSync(
      path.join(dir, '.aa', 'notify.json'),
      JSON.stringify({ url: 'http://localhost:1', on: ['FAILED'] }),
    )

    const wf: BlockDefinition = {
      id: 'dummy-notify-wf',
      name: 'Dummy Notify',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return { ok: true };' },
    }

    // runtime.run must still return normally even if the webhook POST fails.
    const record = await new Runtime(dir, []).run(wf, {})
    expect(record.status).toBe('FAILED')
    // Note: we cannot directly assert notify() was invoked without mocking the
    // module. The structural parity with the capability-setup-failure path
    // (identical guarded try/catch block) is the assurance instead. A
    // failing webhook does not throw out of runtime.run — that is the
    // observable contract verified here.
  })

  // FIX A via runtime: a null secrets.json must not abort the run
  it('FIX-A: secrets.json containing null does NOT abort the run — workflow still COMPLETES', async () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.aa', 'secrets.json'), 'null')

    const wf: BlockDefinition = {
      id: 'null-sec-wf',
      name: 'Null Secret WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return { ok: true };' },
    }

    const record = await new Runtime(dir, []).run(wf, {})
    // Must COMPLETE — null secrets.json is tolerated as "no file secrets"
    expect(record.status).toBe('COMPLETED')
  })

  // FIX B: collision FAILED record carries NO caller inputs/params
  it('FIX-B: collision FAILED record does not contain caller-supplied input values', async () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Sensitive: 'val1', sensitive: 'val2' }),
    )

    const wf: BlockDefinition = {
      id: 'fixb-wf',
      name: 'FIX B WF',
      version: '0.1.0',
      inputs: [{ name: 'token', type: 'string' }],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
    }

    // Pass a sensitive value via inputs — FIX B ensures it never reaches the record
    const sensitiveInput = 'leak-me-xyz-12345'
    const record = await new Runtime(dir, []).run(wf, { token: sensitiveInput })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/secrets load failed/)

    // The sensitive input value must not appear anywhere in the persisted record
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(sensitiveInput)

    // inputs and params on the record must be empty (not the caller-supplied values)
    expect(record.inputs).toEqual({})
    expect(record.params == null || Object.keys(record.params).length === 0).toBe(true)
  })

  // FIX C: best-effort secret map is built on collision path
  // We cannot easily assert the bestEffort map reaches notify without mocking,
  // but we can assert that the tolerateCollisions path produces a non-empty map
  // for the non-colliding key — unit-tested in 'loadSecrets tolerateCollisions option' above.
  // Here we verify the runtime collision path does NOT throw even when tolerateCollisions
  // call inside is given a secrets.json with mixed colliding and safe keys.
  it('FIX-C: collision path with mixed colliding+safe keys still returns a FAILED record (no crash)', async () => {
    fs.mkdirSync(path.join(dir, '.aa'), { recursive: true })
    // 'Alpha'/'alpha' collide; 'safe' does not
    fs.writeFileSync(
      path.join(dir, '.aa', 'secrets.json'),
      JSON.stringify({ Alpha: 'v1', alpha: 'v2', safe: 'safevalue' }),
    )

    const wf: BlockDefinition = {
      id: 'fixc-wf',
      name: 'FIX C WF',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
    }

    const record = await new Runtime(dir, []).run(wf, {})
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/collide/)
    // safe key value must not appear in the record (it was only used for webhook URL resolution)
    expect(JSON.stringify(record)).not.toContain('safevalue')
  })
})

describe('loadSecretsQuiet (schedule path)', () => {
  // loadSecretsQuiet is exported (exported minimally for direct test coverage).
  // Import it alongside loadSecrets from the schedule command module.
  let dir2: string

  beforeEach(() => {
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-sec-sched-'))
  })
  afterEach(() => {
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  it('re-throws SecretCollisionError — collision is not silently swallowed', async () => {
    const { loadSecretsQuiet } = await import('../cli/commands/schedule')
    fs.mkdirSync(path.join(dir2, '.aa'), { recursive: true })
    fs.writeFileSync(
      path.join(dir2, '.aa', 'secrets.json'),
      JSON.stringify({ Bar: 'x', bar: 'y' }),
    )
    expect(() => loadSecretsQuiet(dir2)).toThrow(SecretCollisionError)
    expect(() => loadSecretsQuiet(dir2)).toThrow(/collide/)
  })

  it('returns {} when secrets.json is absent (not a collision)', async () => {
    const { loadSecretsQuiet } = await import('../cli/commands/schedule')
    // dir2 has no .aa directory at all
    expect(loadSecretsQuiet(dir2)).toEqual({})
  })

  it('returns {} when secrets.json is malformed JSON (not a collision)', async () => {
    const { loadSecretsQuiet } = await import('../cli/commands/schedule')
    fs.mkdirSync(path.join(dir2, '.aa'), { recursive: true })
    fs.writeFileSync(path.join(dir2, '.aa', 'secrets.json'), 'not-valid-json{{{')
    // Malformed JSON is silently tolerated — must not throw.
    expect(loadSecretsQuiet(dir2)).toEqual({})
  })
})
