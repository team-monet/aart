import type { Registry } from '../registry/file-registry'
import type { Field } from '../core/types'
import { statusLabel, type ApprovalStatus } from '../core/approval'

/** A compact, machine-readable view of a registered block for the agent. */
export interface CatalogEntry {
  id: string
  version: string
  type: 'node' | 'workflow' | 'native' | 'command'
  /** Governance state: 'native' (trusted pack block) or draft/approved/deprecated. */
  status: ApprovalStatus | 'native'
  name: string
  description?: string
  capabilities?: string[]
  /** For `node` blocks: declared npm deps — present means it runs unsandboxed on the host. */
  dependencies?: string[]
  inputs: Field[]
  outputs: Field[]
  category?: string
  keywords?: string[]
  /** First example from the block's examples array, surfaced for quick reference. */
  example?: { description: string; inputs: Record<string, unknown> }
}

export function buildCatalog(registry: Registry): CatalogEntry[] {
  return registry.listBlocks().map((b) => ({
    id: b.id,
    version: b.version,
    type: b.execution.type,
    status: statusLabel(b),
    name: b.name,
    description: b.description,
    capabilities: b.capabilities,
    dependencies: b.execution.type === 'node' ? b.execution.dependencies : undefined,
    inputs: b.inputs,
    outputs: b.outputs,
    category: b.category,
    keywords: b.keywords,
    example: b.examples?.[0],
  }))
}

export interface CatalogFilter {
  category?: string
  query?: string
}

export function filterCatalog(entries: CatalogEntry[], filter: CatalogFilter): CatalogEntry[] {
  let out = entries
  if (filter.category) out = out.filter((e) => e.category === filter.category)
  if (filter.query) {
    const q = filter.query.toLowerCase()
    out = out.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.keywords ?? []).some((k) => k.toLowerCase().includes(q)) ||
        (e.category ?? '').toLowerCase().includes(q),
    )
  }
  return out
}
