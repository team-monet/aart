import {
  BlockDefinitionSchema,
  WorkflowExecutionSchema,
  type BlockDefinition,
} from '../core/types'

/**
 * Validation guardrails for AI-generated artifacts. zod handles structural
 * validation today; the deeper code guardrail (TS-compiler syntax + reference
 * + output-type checks, ported and HARDENED from the legacy static-analyzer)
 * lands with Phase 5 and must actually gate registry writes — the legacy
 * analyzer was imported but never called, so generated code was saved unchecked.
 */

export interface ValidationResult {
  ok: boolean
  errors: string[]
  block?: BlockDefinition
}

/** Structural validation of a generated block/workflow against the core schema. */
export function validateDefinition(value: unknown): ValidationResult {
  const parsed = BlockDefinitionSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
  }
  return { ok: true, errors: [], block: parsed.data }
}

/** Cross-check that a workflow references only known blocks. */
export function validateWorkflowRefs(
  block: BlockDefinition,
  knownBlockIds: Set<string>,
): ValidationResult {
  const exec = WorkflowExecutionSchema.safeParse(block.execution)
  if (!exec.success) return { ok: true, errors: [] } // not a workflow; nothing to check
  const missing = exec.data.steps
    .map((s) => s.block)
    .filter((id) => !knownBlockIds.has(id))
  return missing.length
    ? { ok: false, errors: missing.map((id) => `unknown block referenced: ${id}`) }
    : { ok: true, errors: [], block }
}

/** Phase 5: harden the legacy static-analyzer concept and call it here. */
export function analyzeBlockCode(_code: string): ValidationResult {
  throw new Error('analyzeBlockCode not implemented — Phase 5')
}
