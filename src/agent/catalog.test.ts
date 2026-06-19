/**
 * Tests for catalog discoverability: buildCatalog new fields + filterCatalog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { buildCatalog, filterCatalog } from './catalog'
import type { BlockDefinition } from '../core/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const node = (id: string, overrides: Partial<BlockDefinition> = {}): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'node', code: 'return {};' },
  ...overrides,
})

describe('buildCatalog — discoverability fields', () => {
  let dir: string
  let registry: FileRegistry

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-cat-'))
    registry = new FileRegistry(path.join(dir, 'registry'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('includes category, keywords, and example (first example) for a block that declares them', () => {
    const b = node('http.request', {
      category: 'http',
      keywords: ['probe', 'ping', 'rest'],
      examples: [
        { description: 'GET a URL', inputs: { url: 'https://example.com', method: 'GET' } },
        { description: 'POST JSON', inputs: { url: 'https://example.com', method: 'POST' } },
      ],
    })
    registry.registerBlock(b)
    const entries = buildCatalog(registry)
    const entry = entries.find((e) => e.id === 'http.request')
    expect(entry).toBeDefined()
    expect(entry!.category).toBe('http')
    expect(entry!.keywords).toEqual(['probe', 'ping', 'rest'])
    expect(entry!.example).toEqual({ description: 'GET a URL', inputs: { url: 'https://example.com', method: 'GET' } })
  })

  it('example is the FIRST example only (not the full list)', () => {
    const b = node('data.parse', {
      category: 'data',
      examples: [
        { description: 'first', inputs: { text: '{}', format: 'json' } },
        { description: 'second', inputs: { text: '', format: 'yaml' } },
      ],
    })
    registry.registerBlock(b)
    const entry = buildCatalog(registry).find((e) => e.id === 'data.parse')!
    expect(entry.example!.description).toBe('first')
  })

  it('category, keywords, and example are undefined for a block that declares none', () => {
    registry.registerBlock(node('bare.block'))
    const entry = buildCatalog(registry).find((e) => e.id === 'bare.block')!
    expect(entry.category).toBeUndefined()
    expect(entry.keywords).toBeUndefined()
    expect(entry.example).toBeUndefined()
  })

  it('does not break existing consumers — id/name/type/status/inputs/outputs are present', () => {
    const b = node('core.thing', { category: 'flow' })
    registry.registerBlock(b)
    const entry = buildCatalog(registry).find((e) => e.id === 'core.thing')!
    expect(entry.id).toBe('core.thing')
    expect(entry.name).toBe('core.thing')
    expect(entry.type).toBe('node')
    expect(entry.inputs).toEqual([])
    expect(entry.outputs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// filterCatalog
// ---------------------------------------------------------------------------

describe('filterCatalog', () => {
  const entries = [
    {
      id: 'http.request',
      version: '0.1.0',
      type: 'native' as const,
      status: 'native' as const,
      name: 'HTTP Request',
      description: 'Send an HTTP request',
      category: 'http',
      keywords: ['probe', 'ping', 'rest', 'api'],
      inputs: [],
      outputs: [],
    },
    {
      id: 'browser.goto',
      version: '0.1.0',
      type: 'native' as const,
      status: 'native' as const,
      name: 'Navigate',
      description: 'Navigate a browser to a URL',
      category: 'browser',
      keywords: ['navigate', 'open', 'page'],
      inputs: [],
      outputs: [],
    },
    {
      id: 'assert.equals',
      version: '0.1.0',
      type: 'native' as const,
      status: 'native' as const,
      name: 'Assert Equals',
      description: 'Assert two values are equal',
      category: 'assert',
      keywords: ['check', 'compare'],
      inputs: [],
      outputs: [],
    },
    {
      id: 'flow.sleep',
      version: '0.1.0',
      type: 'native' as const,
      status: 'native' as const,
      name: 'Sleep',
      description: 'Pause for N milliseconds',
      // no category or keywords
      inputs: [],
      outputs: [],
    },
  ]

  it('empty filter returns all entries', () => {
    expect(filterCatalog(entries, {})).toHaveLength(4)
  })

  it('filters by category exact-match', () => {
    const r = filterCatalog(entries, { category: 'http' })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('http.request')
  })

  it('category filter is exact — "brow" does not match "browser"', () => {
    const r = filterCatalog(entries, { category: 'brow' })
    expect(r).toHaveLength(0)
  })

  it('filters by query matching id (case-insensitive)', () => {
    const r = filterCatalog(entries, { query: 'HTTP.Request' })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('http.request')
  })

  it('filters by query matching name', () => {
    const r = filterCatalog(entries, { query: 'navigate' })
    expect(r.map((e) => e.id)).toContain('browser.goto')
  })

  it('filters by query matching description', () => {
    const r = filterCatalog(entries, { query: 'milliseconds' })
    expect(r.map((e) => e.id)).toContain('flow.sleep')
  })

  it('filters by query matching a keyword', () => {
    const r = filterCatalog(entries, { query: 'ping' })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('http.request')
  })

  it('filters by query matching category string', () => {
    const r = filterCatalog(entries, { query: 'browser' })
    // matches category field AND name contains "Navigate" which doesn't match,
    // but category 'browser' does match query 'browser'
    expect(r.map((e) => e.id)).toContain('browser.goto')
  })

  it('query is case-insensitive', () => {
    const r = filterCatalog(entries, { query: 'PROBE' })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('http.request')
  })

  it('combined category + query narrows results', () => {
    // category='http' AND query='ping': only http.request (which has 'ping' keyword) matches
    const r = filterCatalog(entries, { category: 'http', query: 'ping' })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('http.request')
  })

  it('combined category + query returns empty when category matches but query does not', () => {
    const r = filterCatalog(entries, { category: 'http', query: 'browser' })
    expect(r).toHaveLength(0)
  })

  it('handles entries with no category or keywords without throwing', () => {
    const r = filterCatalog(entries, { query: 'sleep' })
    expect(r.map((e) => e.id)).toContain('flow.sleep')
  })
})
