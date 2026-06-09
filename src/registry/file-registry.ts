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
 *   - reads a single known file per lookup (legacy re-read & re-parsed the WHOLE
 *     dir per step). Reads are fresh, so external writes (e.g. `aart approve`)
 *     are seen immediately.
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

  // Read fresh each call (a single small file) so an external process
  // writing/approving a definition — e.g. `aart approve` while an `aart mcp`
  // server is running — is always seen. This is still far cheaper than the
  // legacy registry, which re-read and re-parsed the WHOLE directory per step.
  getBlock(id: string, version = 'latest'): BlockDefinition | undefined {
    const resolved = version === 'latest' ? this.latestVersion(id) : version
    if (!resolved) return undefined
    const file = this.file(id, resolved)
    if (!fs.existsSync(file)) return undefined
    return BlockDefinitionSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')))
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
