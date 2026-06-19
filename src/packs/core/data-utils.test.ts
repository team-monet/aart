/**
 * Unit tests for data-utils blocks:
 *   json.get, text.template, base64.encode, base64.decode, hash.sha256, regex.match
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../../core/context'
import { ArtifactStore } from '../../artifacts/artifact-store'
import { jsonGet, textTemplate, base64Encode, base64Decode, hashSha256, regexMatch } from './data-utils'
import type { ExecutionContext } from '../../core/context'

let dir: string
let ctx: ExecutionContext

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-data-utils-'))
  ctx = createContext({ workspace: dir, artifacts: new ArtifactStore(path.join(dir, 'run')) })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// json.get
// ---------------------------------------------------------------------------

describe('json.get', () => {
  it('extracts a nested value by dot-path from an object', async () => {
    const data = { user: { name: 'Alice', age: 30 } }
    const out = await jsonGet.run(ctx, { data, path: 'user.name' })
    expect(out.value).toBe('Alice')
  })

  it('returns fallback when the path is missing', async () => {
    const out = await jsonGet.run(ctx, { data: { a: 1 }, path: 'a.b.c', fallback: 'default' })
    expect(out.value).toBe('default')
  })

  it('returns undefined (not fallback) when fallback is not provided and path misses', async () => {
    const out = await jsonGet.run(ctx, { data: { a: 1 }, path: 'x.y' })
    expect(out.value).toBeUndefined()
  })

  it('auto-parses a JSON string', async () => {
    const out = await jsonGet.run(ctx, { data: '{"status":"ok"}', path: 'status' })
    expect(out.value).toBe('ok')
  })

  it('returns fallback when given a non-JSON string (path never resolves)', async () => {
    const out = await jsonGet.run(ctx, { data: 'not json', path: 'a', fallback: 'fb' })
    expect(out.value).toBe('fb')
  })

  it('extracts a top-level key', async () => {
    const out = await jsonGet.run(ctx, { data: { score: 42 }, path: 'score' })
    expect(out.value).toBe(42)
  })

  it('returns falsy value (0, false) — not the fallback', async () => {
    const out = await jsonGet.run(ctx, { data: { flag: false }, path: 'flag', fallback: true })
    expect(out.value).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// text.template
// ---------------------------------------------------------------------------

describe('text.template', () => {
  it('substitutes known placeholders', async () => {
    const out = await textTemplate.run(ctx, {
      template: 'Hello, {name}! You have {count} messages.',
      values: { name: 'Bob', count: 5 },
    })
    expect(out.text).toBe('Hello, Bob! You have 5 messages.')
  })

  it('leaves unknown placeholders untouched', async () => {
    const out = await textTemplate.run(ctx, {
      template: 'Hi {name}, your code is {code}.',
      values: { name: 'Alice' },
    })
    expect(out.text).toBe('Hi Alice, your code is {code}.')
  })

  it('stringifies non-string values', async () => {
    const out = await textTemplate.run(ctx, {
      template: 'Count: {n}',
      values: { n: 42 },
    })
    expect(out.text).toBe('Count: 42')
  })

  it('works with empty values (no substitutions)', async () => {
    const out = await textTemplate.run(ctx, { template: 'no placeholders here', values: {} })
    expect(out.text).toBe('no placeholders here')
  })

  it('defaults values to {} when omitted', async () => {
    const out = await textTemplate.run(ctx, { template: 'static text' })
    expect(out.text).toBe('static text')
  })
})

// ---------------------------------------------------------------------------
// base64.encode / base64.decode
// ---------------------------------------------------------------------------

describe('base64.encode / base64.decode', () => {
  it('encodes a simple string', async () => {
    const out = await base64Encode.run(ctx, { data: 'hello world' })
    expect(out.encoded).toBe('aGVsbG8gd29ybGQ=')
  })

  it('decodes back to the original (round-trip)', async () => {
    const original = 'user:p@$$word!123'
    const { encoded } = await base64Encode.run(ctx, { data: original })
    const { decoded } = await base64Decode.run(ctx, { data: encoded as string })
    expect(decoded).toBe(original)
  })

  it('decodes a known base64 string', async () => {
    const out = await base64Decode.run(ctx, { data: 'SGVsbG8gV29ybGQ=' })
    expect(out.decoded).toBe('Hello World')
  })

  it('handles empty string', async () => {
    const { encoded } = await base64Encode.run(ctx, { data: '' })
    expect(encoded).toBe('')
    const { decoded } = await base64Decode.run(ctx, { data: '' })
    expect(decoded).toBe('')
  })

  it('handles unicode content', async () => {
    const original = '日本語テスト🎉'
    const { encoded } = await base64Encode.run(ctx, { data: original })
    const { decoded } = await base64Decode.run(ctx, { data: encoded as string })
    expect(decoded).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// hash.sha256
// ---------------------------------------------------------------------------

describe('hash.sha256', () => {
  // Known SHA-256 hash of the empty string
  const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  it('returns a known vector for the empty string (hex)', async () => {
    const out = await hashSha256.run(ctx, { data: '' })
    expect(out.hash).toBe(EMPTY_SHA256_HEX)
  })

  it('returns a known vector for "hello world" (hex)', async () => {
    const out = await hashSha256.run(ctx, { data: 'hello world' })
    // sha256('hello world') = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(out.hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })

  it('returns 64-character hex output', async () => {
    const out = await hashSha256.run(ctx, { data: 'test input' })
    expect(String(out.hash)).toHaveLength(64)
    expect(String(out.hash)).toMatch(/^[0-9a-f]+$/)
  })

  it('returns base64 output when encoding=base64', async () => {
    const out = await hashSha256.run(ctx, { data: '', encoding: 'base64' })
    // Base64 of empty string SHA-256 should be a valid base64 string of length 44
    expect(String(out.hash)).toHaveLength(44)
    // The base64 of the empty string SHA-256 is a known value
    expect(out.hash).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
  })

  it('defaults to hex encoding', async () => {
    const withDefault = await hashSha256.run(ctx, { data: 'abc' })
    const withExplicit = await hashSha256.run(ctx, { data: 'abc', encoding: 'hex' })
    expect(withDefault.hash).toBe(withExplicit.hash)
  })

  it('same input always yields same hash (deterministic)', async () => {
    const a = await hashSha256.run(ctx, { data: 'consistent' })
    const b = await hashSha256.run(ctx, { data: 'consistent' })
    expect(a.hash).toBe(b.hash)
  })

  it('different inputs yield different hashes', async () => {
    const a = await hashSha256.run(ctx, { data: 'foo' })
    const b = await hashSha256.run(ctx, { data: 'bar' })
    expect(a.hash).not.toBe(b.hash)
  })
})

// ---------------------------------------------------------------------------
// regex.match
// ---------------------------------------------------------------------------

describe('regex.match', () => {
  it('returns matched:true and the full match on a hit', async () => {
    const out = await regexMatch.run(ctx, { text: 'Version: 1.2.3', pattern: '\\d+\\.\\d+\\.\\d+' })
    expect(out.matched).toBe(true)
    expect(out.match).toBe('1.2.3')
  })

  it('returns matched:false, match:null, groups:[] on no match — does NOT throw', async () => {
    const out = await regexMatch.run(ctx, { text: 'hello', pattern: '\\d+' })
    expect(out.matched).toBe(false)
    expect(out.match).toBeNull()
    expect(out.groups).toEqual([])
  })

  it('returns capture groups', async () => {
    const out = await regexMatch.run(ctx, {
      text: 'Date: 2025-06-19',
      pattern: '(\\d{4})-(\\d{2})-(\\d{2})',
    })
    expect(out.matched).toBe(true)
    expect(out.groups).toEqual(['2025', '06', '19'])
  })

  it('respects flags (case-insensitive)', async () => {
    const out = await regexMatch.run(ctx, { text: 'Hello World', pattern: 'hello world', flags: 'i' })
    expect(out.matched).toBe(true)
    expect(String(out.match).toLowerCase()).toBe('hello world')
  })

  it('defaults flags to empty string', async () => {
    const out = await regexMatch.run(ctx, { text: 'HELLO', pattern: 'hello' })
    expect(out.matched).toBe(false)
  })
})
