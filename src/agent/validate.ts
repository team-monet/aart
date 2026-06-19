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
  warnings: string[]
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
      warnings: [],
    }
  }
  return { ok: true, errors: [], warnings: [], block: parsed.data }
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
  // Reserved step ids: these collide with typed $-ref roots or loop builtins.
  // 'item' is excluded — loop-variable shadowing is documented behavior.
  const RESERVED_STEP_IDS = new Set(['loop', 'inputs', 'params', 'ctx', 'secrets', 'steps'])
  for (const step of exec.data.steps) {
    if (RESERVED_STEP_IDS.has(step.id)) {
      errors.push(
        `step "${step.id}": "${step.id}" is a reserved id — it collides with the $${step.id} typed-reference root (or loop builtin); use a different step id`,
      )
    }
    // Reserve all typed $-ref root names as `as` binding names.
    // A step with `as: inputs` (for example) makes `$inputs.x` resolve to the
    // loop item (the resolver checks loopVar before typed roots for the $-syntax),
    // while `{{inputs.x}}` still resolves to the workflow input — silent divergence
    // between the two syntaxes.  Reject all six reserved roots here so authors
    // discover the collision at registration time, not at run time.
    if (step.as !== undefined && RESERVED_STEP_IDS.has(step.as)) {
      errors.push(
        `step "${step.id}": as: "${step.as}" is reserved — it would shadow the $${step.as} typed-reference root (or loop builtin); use a different binding name`,
      )
    }
    // `as` becomes a reference root ({{<as>.field}} / $<as>.field), so it must be a
    // valid identifier in the resolver's interpolation grammar (letters/digits/_ ).
    // A name like "endpoint-item" passes the checks above but {{endpoint-item.url}}
    // never matches the interpolation regex and is silently left as a literal.
    if (step.as !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.as)) {
      errors.push(
        `step "${step.id}": as: "${step.as}" is not a valid binding name — use letters, digits and underscores only (start with a letter or underscore) so {{${step.as}.field}} resolves`,
      )
    }
    const ref = step.version ? `${step.block}@${step.version}` : step.block
    if (!seen.has(ref)) {
      seen.add(ref)
      if (step.block === block.id) {
        errors.push(`references itself (${step.block}) — a workflow cannot invoke itself`)
      } else if (!registry.getBlock(step.block, step.version)) {
        errors.push(`references unknown block: ${ref}`)
      }
    }
    // forEach + if/then/else/next is ambiguous control flow.
    if (step.forEach !== undefined) {
      const conflicts = (['if', 'then', 'else', 'next'] as const).filter((k) => step[k] !== undefined)
      if (conflicts.length) {
        errors.push(
          `step "${step.id}": forEach cannot be combined with ${conflicts.join('/')} — control flow is ambiguous`,
        )
      }
      if (step.forEach === '') {
        errors.push(`step "${step.id}": forEach must not be an empty string`)
      }
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
  const warnings: string[] = []
  // Static gates for node blocks: dependency entries must be well-formed
  // (registry name@range or node: built-ins only), and the code must compile.
  // Dependency-bearing blocks compile against the host signature (and don't
  // need isolated-vm); sandboxed blocks compile in the isolate.
  if (block.execution.type === 'node') {
    const deps = block.execution.dependencies ?? []
    const depErrors = checkDependencies(deps)
    if (depErrors.length) return { ok: false, errors: depErrors, warnings, block }
    const syntaxErr = deps.length
      ? checkHostNodeSyntax(block.execution.code)
      : checkNodeSyntax(block.execution.code)
    if (syntaxErr) return { ok: false, errors: [`code: ${syntaxErr}`], warnings, block }
  }
  // Input constraints must be well-formed: a pattern that doesn't compile
  // would otherwise fail every future run instead of failing registration.
  for (const field of block.inputs) {
    if (field.pattern !== undefined) {
      try {
        new RegExp(`^(?:${field.pattern})$`)
      } catch (err) {
        return {
          ok: false,
          errors: [`inputs.${field.name}.pattern: invalid regex — ${err instanceof Error ? err.message : String(err)}`],
          warnings,
          block,
        }
      }
    }
    if (field.enum !== undefined && field.enum.length === 0) {
      return { ok: false, errors: [`inputs.${field.name}.enum: must not be empty`], warnings, block }
    }
    if (field.default !== undefined) {
      // A field with both required:true and a default is contradictory — the
      // default makes required moot. Emit a warning, not an error, so authors
      // who are being extra-explicit don't get blocked.
      if (field.required === true) {
        warnings.push(
          `inputs.${field.name}: has both "required: true" and a "default" — the default makes required moot`,
        )
      }
      // Validate the default against enum/pattern at registration time so
      // a default that would always fail at run time is caught early.
      if (field.enum !== undefined && !field.enum.includes(field.default as string | number)) {
        return {
          ok: false,
          errors: [
            `inputs.${field.name}.default: value ${JSON.stringify(field.default)} is not in enum [${field.enum.join(', ')}]`,
          ],
          warnings,
          block,
        }
      }
      if (field.pattern !== undefined && typeof field.default === 'string') {
        if (!new RegExp(`^(?:${field.pattern})$`).test(field.default)) {
          return {
            ok: false,
            errors: [
              `inputs.${field.name}.default: value ${JSON.stringify(field.default)} does not match pattern ${field.pattern}`,
            ],
            warnings,
            block,
          }
        }
      }
    }
  }
  // Command blocks: the binary and cwd are part of what the user approves —
  // they must be fixed strings. Only argv slots and env values interpolate.
  if (block.execution.type === 'command') {
    const errors: string[] = []
    if (!block.execution.command.trim()) errors.push('command: must not be empty')
    if (block.execution.command.includes('{{')) {
      errors.push('command: must be a fixed binary — no {{interpolation}} (put dynamic parts in args)')
    }
    if (block.execution.cwd?.includes('{{')) {
      errors.push('cwd: must be a fixed workspace-relative path — no {{interpolation}}')
    }
    if (errors.length) return { ok: false, errors, warnings, block }
  }
  // Workflow-level forEach warnings: `as` set without `forEach` is a no-op.
  if (block.execution.type === 'workflow') {
    for (const step of block.execution.steps) {
      if (step.as !== undefined && step.forEach === undefined) {
        warnings.push(
          `step "${step.id}": "as" is set but "forEach" is absent — "as" has no effect`,
        )
      }
    }
  }
  const refErrors = validateWorkflowRefs(block, registry)
  return refErrors.length
    ? { ok: false, errors: refErrors, warnings, block }
    : { ...structural, warnings }
}
