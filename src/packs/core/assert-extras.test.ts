/**
 * Unit tests for assert-extras blocks:
 *   assert.match, assert.range
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../../core/context'
import { ArtifactStore } from '../../artifacts/artifact-store'
import { assertMatch, assertRange } from './assert-extras'
import type { ExecutionContext } from '../../core/context'

let dir: string
let ctx: ExecutionContext

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-assert-extras-'))
  ctx = createContext({ workspace: dir, artifacts: new ArtifactStore(path.join(dir, 'run')) })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// assert.match
// ---------------------------------------------------------------------------

describe('assert.match', () => {
  it('passes and returns ok:true + match when the regex matches', async () => {
    const out = await assertMatch.run(ctx, { value: 'version: 1.2.3', pattern: '\\d+\\.\\d+\\.\\d+' })
    expect(out.ok).toBe(true)
    expect(out.match).toBe('1.2.3')
  })

  it('throws with a clear message when the regex does not match', async () => {
    await expect(
      assertMatch.run(ctx, { value: 'hello world', pattern: '^\\d+$' })
    ).rejects.toThrow(/Assertion failed/)
  })

  it('throw message includes the value and pattern', async () => {
    await expect(
      assertMatch.run(ctx, { value: 'abc', pattern: '\\d+' })
    ).rejects.toThrow(/\\d\+/)
  })

  it('respects flags (case-insensitive match)', async () => {
    const out = await assertMatch.run(ctx, { value: 'HELLO', pattern: 'hello', flags: 'i' })
    expect(out.ok).toBe(true)
  })

  it('fails on case-sensitive mismatch (no flag)', async () => {
    await expect(
      assertMatch.run(ctx, { value: 'HELLO', pattern: 'hello' })
    ).rejects.toThrow(/Assertion failed/)
  })

  it('defaults flags to empty string when omitted', async () => {
    // Pattern 'world' should match 'hello world' even without flags
    const out = await assertMatch.run(ctx, { value: 'hello world', pattern: 'world' })
    expect(out.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// assert.range
// ---------------------------------------------------------------------------

describe('assert.range', () => {
  it('passes when value is within [min, max]', async () => {
    const out = await assertRange.run(ctx, { value: 500, min: 0, max: 2000 })
    expect(out.ok).toBe(true)
  })

  it('passes with only max (no lower bound)', async () => {
    const out = await assertRange.run(ctx, { value: 100, max: 2000 })
    expect(out.ok).toBe(true)
  })

  it('passes with only min (no upper bound)', async () => {
    const out = await assertRange.run(ctx, { value: 100, min: 50 })
    expect(out.ok).toBe(true)
  })

  it('passes with neither bound (trivially true)', async () => {
    const out = await assertRange.run(ctx, { value: 999999 })
    expect(out.ok).toBe(true)
  })

  it('throws when value < min', async () => {
    await expect(
      assertRange.run(ctx, { value: -1, min: 0 })
    ).rejects.toThrow(/less than min/)
  })

  it('throws when value > max', async () => {
    await expect(
      assertRange.run(ctx, { value: 2001, max: 2000 })
    ).rejects.toThrow(/greater than max/)
  })

  it('passes at exactly min', async () => {
    const out = await assertRange.run(ctx, { value: 0, min: 0, max: 100 })
    expect(out.ok).toBe(true)
  })

  it('passes at exactly max', async () => {
    const out = await assertRange.run(ctx, { value: 100, min: 0, max: 100 })
    expect(out.ok).toBe(true)
  })

  it('throw message contains the value and bound', async () => {
    await expect(
      assertRange.run(ctx, { value: 3000, max: 2000 })
    ).rejects.toThrow(/3000/)
  })
})
