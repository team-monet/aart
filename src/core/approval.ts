import type { BlockDefinition } from './types'
import type { Registry } from '../registry/file-registry'

export type ApprovalStatus = 'draft' | 'approved' | 'deprecated'

/** Native (pack) blocks are trusted runtime code; otherwise only 'approved' counts. */
export function isApproved(block: BlockDefinition): boolean {
  return block.execution.type === 'native' || block.approval === 'approved'
}

/** Status label for display. */
export function statusLabel(block: BlockDefinition): ApprovalStatus | 'native' {
  if (block.execution.type === 'native') return 'native'
  return block.approval ?? 'draft'
}

/**
 * Ids in a definition's tree that are NOT approved (so a run would need user
 * sign-off). Referenced blocks are resolved from the registry, whose approval
 * field is trusted (only `aart approve` writes 'approved'). `trustTop` controls
 * whether the top-level def's own approval is trusted — false for an ad-hoc
 * file/inline definition whose YAML the runtime didn't vet.
 */
export function unapprovedInTree(
  def: BlockDefinition,
  registry: Registry,
  trustTop: boolean,
): string[] {
  const pending: string[] = []
  const seen = new Set<string>()
  const visit = (b: BlockDefinition, trust: boolean) => {
    if (seen.has(b.id)) return
    seen.add(b.id)
    const ok = b.execution.type === 'native' || (trust && b.approval === 'approved')
    if (!ok) pending.push(b.id)
    if (b.execution.type === 'workflow') {
      for (const step of b.execution.steps) {
        const child = registry.getBlock(step.block, step.version)
        if (child) visit(child, true) // referenced blocks come from the trusted registry
      }
    }
  }
  visit(def, trustTop)
  return [...new Set(pending)]
}
