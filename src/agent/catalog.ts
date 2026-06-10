import type { Registry } from '../registry/file-registry'
import type { Field } from '../core/types'
import { statusLabel, type ApprovalStatus } from '../core/approval'

/** A compact, machine-readable view of a registered block for the agent. */
export interface CatalogEntry {
  id: string
  version: string
  type: 'node' | 'workflow' | 'native'
  /** Governance state: 'native' (trusted pack block) or draft/approved/deprecated. */
  status: ApprovalStatus | 'native'
  name: string
  description?: string
  capabilities?: string[]
  /** For `node` blocks: declared npm deps — present means it runs unsandboxed on the host. */
  dependencies?: string[]
  inputs: Field[]
  outputs: Field[]
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
  }))
}
