import { unapprovedInTree, type ApprovalStatus } from './approval'
import type { Registry } from '../registry/file-registry'

export interface SetApprovalResult {
  ok: boolean
  id: string
  version?: string
  /** For an approve: referenced blocks that are still not approved. */
  pending?: string[]
  error?: string
}

/**
 * Set a registered definition's approval status. Shared by the CLI
 * (`aart approve`) and the MCP `aa_approve` tool so both behave identically.
 * Built-in pack blocks are already trusted and cannot be (de)approved.
 */
export function setApproval(
  registry: Registry,
  id: string,
  status: ApprovalStatus,
  version?: string,
): SetApprovalResult {
  const block = registry.getBlock(id, version)
  if (!block) {
    return { ok: false, id, error: `not found: ${id}${version ? '@' + version : ''}` }
  }
  if (block.execution.type === 'native') {
    return { ok: false, id, error: `${id} is a built-in pack block — already trusted` }
  }
  block.approval = status
  try {
    registry.registerBlock(block)
  } catch (err) {
    // A built-in pack workflow (e.g. http.health-check) or a legacy-alias
    // collision cannot be (de)approved — registerBlock throws. Return a controlled
    // result instead of surfacing a raw exception to `aart approve/deprecate` or
    // the MCP approval tool. (getBlock returns a copy for pack workflows, so the
    // approval mutation above does not touch the stored built-in.)
    return { ok: false, id, error: err instanceof Error ? err.message : String(err) }
  }
  const pending =
    status === 'approved'
      ? unapprovedInTree(block, registry, true).filter((x) => x !== id)
      : []
  return { ok: true, id, version: block.version, pending }
}
