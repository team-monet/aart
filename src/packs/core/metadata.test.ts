/**
 * Completeness test: every built-in block/workflow/command in corePack must
 * have non-empty `category`, a non-empty `keywords` array, at least one
 * `example`, and every example's input keys must be declared inputs of that
 * block (no validateDraft "unknown input key" warning).
 *
 * This test guards the catalog from silently regressing as new blocks are added.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../../core/runtime'
import { buildCatalog } from '../../agent/catalog'
import { corePack } from './index'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-metadata-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('corePack built-in metadata completeness', () => {
  it('every block/workflow/command has category, keywords, and at least one example with valid input keys', () => {
    const rt = new Runtime(dir, [corePack])
    const catalog = buildCatalog(rt.registry)

    // Filter to only the blocks originating from corePack (status=native or
    // status=approved). Exclude any that might be in the file registry.
    const packIds = new Set([
      ...corePack.blocks.map((b) => b.def.id),
      ...(corePack.workflows ?? []).map((w) => w.id),
      ...(corePack.commands ?? []).map((c) => c.id),
    ])

    const packEntries = catalog.filter((e) => packIds.has(e.id))

    // Sanity: make sure we found every id we expected.
    const foundIds = new Set(packEntries.map((e) => e.id))
    for (const id of packIds) {
      expect(foundIds, `block "${id}" must appear in the catalog`).toContain(id)
    }

    // Now assert completeness for every pack entry.
    for (const entry of packEntries) {
      const label = `block "${entry.id}"`

      // 1. category must be a non-empty string
      expect(
        typeof entry.category === 'string' && entry.category.length > 0,
        `${label}: category must be a non-empty string (got ${JSON.stringify(entry.category)})`,
      ).toBe(true)

      // 2. keywords must be a non-empty array
      expect(
        Array.isArray(entry.keywords) && entry.keywords.length > 0,
        `${label}: keywords must be a non-empty array (got ${JSON.stringify(entry.keywords)})`,
      ).toBe(true)

      // 3. at least one example
      expect(
        entry.example !== undefined,
        `${label}: must have at least one example`,
      ).toBe(true)
    }
  })

  it('every example only references declared input keys (no validateDraft unknown-key warnings)', () => {
    // We check this directly against the raw block definitions rather than via
    // validateDraft (which needs a registry and a full structural parse), because
    // the goal is purely to catch typos in example input keys.
    const allDefs = [
      ...corePack.blocks.map((b) => b.def),
      ...(corePack.workflows ?? []),
      ...(corePack.commands ?? []),
    ]

    for (const def of allDefs) {
      if (!def.examples || def.examples.length === 0) continue

      const declaredNames = new Set(def.inputs.map((f) => f.name))

      for (const [i, example] of def.examples.entries()) {
        const unknownKeys = Object.keys(example.inputs).filter((k) => !declaredNames.has(k))
        expect(
          unknownKeys,
          `block "${def.id}" examples[${i}]: unknown input key(s) ${unknownKeys.map((k) => `"${k}"`).join(', ')} — not declared in inputs[]`,
        ).toHaveLength(0)
      }
    }
  })
})
