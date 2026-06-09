import {
  BlockDefinitionSchema,
  WorkflowExecutionSchema,
  type BlockDefinition,
} from '../core/types'
import type { Registry } from '../registry/file-registry'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  block?: BlockDefinition
}

/** Structural validation against the core schema. */
export function validateStructure(value: unknown): ValidationResult {
  const parsed = BlockDefinitionSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    }
  }
  return { ok: true, errors: [], block: parsed.data }
}

/** Cross-check that a workflow references only block ids that exist. */
export function validateWorkflowRefs(
  block: BlockDefinition,
  knownIds: Set<string>,
): string[] {
  const exec = WorkflowExecutionSchema.safeParse(block.execution)
  if (!exec.success) return [] // not a workflow; nothing to check
  return [
    ...new Set(
      exec.data.steps
        .map((s) => s.block)
        .filter((id) => !knownIds.has(id)),
    ),
  ].map((id) => `references unknown block: ${id}`)
}

/**
 * Full validation of an agent-authored draft: schema + (for workflows) that
 * every referenced block exists in the registry. This is the gate before
 * registration/execution — the legacy code validated nothing on save.
 */
export function validateDraft(value: unknown, registry: Registry): ValidationResult {
  const structural = validateStructure(value)
  if (!structural.ok || !structural.block) return structural
  const knownIds = new Set(registry.listBlocks().map((b) => b.id))
  // a block may reference itself only if already registered; allow same-id for re-register
  knownIds.add(structural.block.id)
  const refErrors = validateWorkflowRefs(structural.block, knownIds)
  return refErrors.length
    ? { ok: false, errors: refErrors, block: structural.block }
    : structural
}
