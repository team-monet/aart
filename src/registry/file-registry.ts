import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { BlockDefinitionSchema, type BlockDefinition } from '../core/types'

/**
 * Filesystem registry — ported (and cleaned) from the legacy FileSystemRegistry,
 * the one piece of legacy code worth lifting nearly verbatim. Definitions are
 * YAML files at `<base>/blocks/<id>_v<version>.yaml`: git-diffable, no DB.
 *
 * Fixes vs legacy:
 *   - real numeric semver ordering for `latest` (legacy used localeCompare,
 *     so `1.0.10` sorted below `1.0.2`);
 *   - a per-instance cache (legacy re-read & re-parsed the whole dir per step).
 */
export interface Registry {
  getBlock(id: string, version?: string): BlockDefinition | undefined
  listBlocks(): BlockDefinition[]
  registerBlock(block: BlockDefinition): void
  deleteBlock(id: string): void
}

const FILE_RE = /^(.+)_v(.+)\.ya?ml$/

export class FileRegistry implements Registry {
  private dir: string
  private cache = new Map<string, BlockDefinition>()

  constructor(base: string) {
    this.dir = path.join(base, 'blocks')
    fs.mkdirSync(this.dir, { recursive: true })
  }

  private file(id: string, version: string): string {
    return path.join(this.dir, `${id}_v${version}.yaml`)
  }

  registerBlock(block: BlockDefinition): void {
    const parsed = BlockDefinitionSchema.parse(block)
    fs.writeFileSync(this.file(parsed.id, parsed.version), YAML.stringify(parsed))
    this.cache.set(`${parsed.id}_v${parsed.version}`, parsed)
  }

  /** All on-disk (id, version) pairs. */
  private entries(): { id: string; version: string }[] {
    return fs
      .readdirSync(this.dir)
      .map((f) => f.match(FILE_RE))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ id: m[1]!, version: m[2]! }))
  }

  private versionsOf(id: string): string[] {
    return this.entries()
      .filter((e) => e.id === id)
      .map((e) => e.version)
  }

  private latestVersion(id: string): string | undefined {
    const versions = this.versionsOf(id)
    if (!versions.length) return undefined
    return versions.sort((a, b) => compareSemver(b, a))[0]
  }

  getBlock(id: string, version = 'latest'): BlockDefinition | undefined {
    const resolved = version === 'latest' ? this.latestVersion(id) : version
    if (!resolved) return undefined
    const key = `${id}_v${resolved}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const file = this.file(id, resolved)
    if (!fs.existsSync(file)) return undefined
    const def = BlockDefinitionSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')))
    this.cache.set(key, def)
    return def
  }

  listBlocks(): BlockDefinition[] {
    const ids = [...new Set(this.entries().map((e) => e.id))]
    return ids
      .map((id) => this.getBlock(id))
      .filter((b): b is BlockDefinition => b !== undefined)
  }

  deleteBlock(id: string): void {
    for (const version of this.versionsOf(id)) {
      fs.rmSync(this.file(id, version), { force: true })
      this.cache.delete(`${id}_v${version}`)
    }
  }
}

/** Compare two semver-ish strings numerically. Release > prerelease. */
export function compareSemver(a: string, b: string): number {
  const [acore, apre] = a.split('-')
  const [bcore, bpre] = b.split('-')
  const an = acore!.split('.').map((n) => parseInt(n, 10) || 0)
  const bn = bcore!.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const diff = (an[i] ?? 0) - (bn[i] ?? 0)
    if (diff !== 0) return diff
  }
  // Same core: a version WITHOUT a prerelease tag outranks one with it.
  if (!apre && bpre) return 1
  if (apre && !bpre) return -1
  if (apre && bpre) return apre < bpre ? -1 : apre > bpre ? 1 : 0
  return 0
}
