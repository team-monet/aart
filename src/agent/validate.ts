import {
  BlockDefinitionSchema,
  WorkflowExecutionSchema,
  type BlockDefinition,
} from '../core/types'
import { checkNodeSyntax } from '../core/executor'
import { checkDependencies, checkHostNodeSyntax } from '../core/host-runner'
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

/**
 * Check that a workflow's steps reference real, resolvable blocks:
 *   - a direct self-reference is rejected (it never terminates);
 *   - each referenced (id, version) must resolve in the registry — a step
 *     pinned to a nonexistent version of a known block is caught here, not at
 *     run time.
 */
export function validateWorkflowRefs(
  block: BlockDefinition,
  registry: Registry,
): string[] {
  const exec = WorkflowExecutionSchema.safeParse(block.execution)
  if (!exec.success) return [] // not a workflow; nothing to check
  const errors: string[] = []
  const seen = new Set<string>()
  for (const step of exec.data.steps) {
    const ref = step.version ? `${step.block}@${step.version}` : step.block
    if (seen.has(ref)) continue
    seen.add(ref)
    if (step.block === block.id) {
      errors.push(`references itself (${step.block}) — a workflow cannot invoke itself`)
      continue
    }
    if (!registry.getBlock(step.block, step.version)) {
      errors.push(`references unknown block: ${ref}`)
    }
  }
  return errors
}

/**
 * Full validation of an agent-authored draft: schema + (for workflows) that
 * every referenced block resolves and the workflow is not self-referential.
 * This is the gate before registration/execution — the legacy code validated
 * nothing on save.
 */
export function validateDraft(value: unknown, registry: Registry): ValidationResult {
  const structural = validateStructure(value)
  if (!structural.ok || !structural.block) return structural
  const block = structural.block
  // Static gates for node blocks: dependency entries must be well-formed
  // (registry name@range or node: built-ins only), and the code must compile.
  // Dependency-bearing blocks compile against the host signature (and don't
  // need isolated-vm); sandboxed blocks compile in the isolate.
  if (block.execution.type === 'node') {
    const deps = block.execution.dependencies ?? []
    const depErrors = checkDependencies(deps)
    if (depErrors.length) return { ok: false, errors: depErrors, block }
    const syntaxErr = deps.length
      ? checkHostNodeSyntax(block.execution.code)
      : checkNodeSyntax(block.execution.code)
    if (syntaxErr) return { ok: false, errors: [`code: ${syntaxErr}`], block }
  }
  const refErrors = validateWorkflowRefs(block, registry)
  return refErrors.length ? { ok: false, errors: refErrors, block } : structural
}
