import { resolveInputs, resolveValue, resolveTyped, evalCondition, type ResolveScope } from './resolver'
import { runNodeBlock } from './executor'
import { runHostNodeBlock } from './host-runner'
import { runCommandBlock } from './command-runner'
import { secretValues, redactText } from './secrets'
import type { ExecutionContext } from './context'
import type { Registry } from '../registry/file-registry'
import type { NativeRunFn } from '../pack/types'
import type {
  BlockDefinition,
  ExecutionSnapshot,
  RunRecord,
  StepTrace,
  WorkflowStep,
} from './types'

const nowIso = () => new Date().toISOString()
const STEP_LIMIT = 10_000

// Step ids / `as` bindings that collide with a typed $-ref root. validateDraft
// forbids them for new drafts, but registry files are NOT re-validated on run —
// so the engine rejects them defensively, rather than silently resolving e.g.
// $inputs to the workflow root instead of a step output named "inputs".
const RESERVED_REF_ROOTS = new Set(['loop', 'inputs', 'params', 'ctx', 'secrets', 'steps'])

export interface EngineOptions {
  timeoutMs?: number
  /** Per-`node`-block memory ceiling (MB); defaults to the executor's default. */
  memoryMb?: number
  /** Handlers for `native` (pack-provided) blocks, keyed by block id. */
  nativeHandlers?: Map<string, NativeRunFn>
}

/**
 * The workflow interpreter. Pure with respect to I/O: it resolves the engine's
 * inputs against the registry, executes, and returns a RunRecord. Persistence
 * (writing the report) is the caller's job — the engine never touches a DB.
 *
 * Re-implemented from the legacy `WorkflowEngine.run`, but split from execution
 * (the pluggable `runNodeBlock`), persistence (the report writer), and value
 * resolution (the pure `resolver`). The legacy class fused all four.
 */
export class Engine {
  constructor(
    private registry: Registry,
    private opts: EngineOptions = {},
  ) {}

  async run(
    root: BlockDefinition,
    inputs: Record<string, unknown>,
    ctx: ExecutionContext,
    params?: Record<string, unknown>,
  ): Promise<RunRecord> {
    // Record the EFFECTIVE root inputs (with the root block's declared defaults
    // applied), so a direct run of a defaulted block shows what actually ran —
    // not the caller's pre-default inputs. execute() re-applies idempotently.
    const rootInputs = this.applyDefaults(root, inputs)
    const record: RunRecord = {
      runId: ctx.runId,
      blockId: root.id,
      status: 'RUNNING',
      // Snapshot the recorded inputs so a handler that mutates a (defaulted)
      // object/array input in place cannot corrupt the persisted audit trail.
      inputs: structuredClone(rootInputs),
      params,
      trace: [],
      snapshot: this.buildSnapshot(root),
      artifacts: [],
      startedAt: nowIso(),
    }

    try {
      record.results = await this.execute(root, rootInputs, ctx, record, params)
      record.status = 'COMPLETED'
    } catch (err) {
      record.status = 'FAILED'
      record.error = err instanceof Error ? err.message : String(err)
    }

    record.endedAt = nowIso()
    record.artifacts = ctx.artifacts.list()
    return record
  }

  /** Execute one block (recursively for workflows). Returns its outputs. */
  /** Apply a block's declared field defaults to inputs. Object/array defaults are
   *  structuredCloned so a handler that mutates inputs cannot corrupt the
   *  registry-held default. Idempotent: a value already present is left untouched.
   *  Used both when executing a block and when recording the parent step trace, so
   *  the trace reflects the effective inputs the block actually ran with. */
  private applyDefaults(
    block: BlockDefinition,
    inputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...inputs }
    for (const field of block.inputs) {
      if (out[field.name] === undefined && field.default !== undefined) {
        out[field.name] =
          field.default !== null && typeof field.default === 'object'
            ? structuredClone(field.default)
            : field.default
      }
    }
    return out
  }

  private async execute(
    block: BlockDefinition,
    inputs: Record<string, unknown>,
    ctx: ExecutionContext,
    record: RunRecord,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Apply declared defaults (object/array defaults cloned) before the required/
    // enum/pattern checks below. Routed through applyDefaults so a parent workflow
    // records the SAME effective inputs in the step trace (see the trace sites).
    const resolvedInputs = this.applyDefaults(block, inputs)

    // Enforce declared required inputs and safe-interface constraints at the
    // engine boundary, for every block type, so an omitted input fails fast
    // and a constrained input (enum/pattern) can never reach the block with a
    // value the user didn't approve the shape of.
    for (const field of block.inputs) {
      const value = resolvedInputs[field.name]
      if (field.required && value === undefined) {
        throw new Error(`Missing required input "${field.name}" for block ${block.id}`)
      }
      if (value === undefined) continue
      if (field.enum && !field.enum.includes(value as string | number)) {
        throw new Error(
          `Input "${field.name}" for block ${block.id} must be one of: ${field.enum.join(', ')} (got ${JSON.stringify(value)})`,
        )
      }
      if (field.pattern !== undefined) {
        // Full match — a partial hit must not pass a gate like "^[a-z-]+$".
        // Apply against String(value) for any non-undefined value so numeric
        // inputs like -1 or 3.5 are covered (typeof -1 === 'number', not 'string').
        // String('x') === 'x', so existing string-typed inputs are unaffected.
        if (!new RegExp(`^(?:${field.pattern})$`).test(String(value))) {
          throw new Error(
            `Input "${field.name}" for block ${block.id} must match pattern ${field.pattern} (got ${JSON.stringify(value)})`,
          )
        }
      }
    }

    if (block.execution.type === 'node') {
      // Two tiers: declared dependencies → real Node subprocess with those npm
      // packages (approval-gated, unsandboxed); otherwise the pure-compute isolate.
      const deps = block.execution.dependencies
      const res = deps?.length
        ? await runHostNodeBlock(block.execution.code, deps, resolvedInputs, ctx, {
            timeoutMs: this.opts.timeoutMs,
          })
        : await runNodeBlock(block.execution.code, resolvedInputs, ctx, {
            timeoutMs: this.opts.timeoutMs,
            memoryMb: this.opts.memoryMb,
          })
      // Mask secrets that a block may have printed before logging to stderr.
      const sv = res.logs.length ? secretValues(ctx.secrets) : []
      for (const line of res.logs) ctx.logger.debug(`[${block.id}] ${redactText(line, sv)}`)
      return res.output
    }

    if (block.execution.type === 'command') {
      const res = await runCommandBlock(block.execution, resolvedInputs, params, ctx)
      return res.output
    }

    if (block.execution.type === 'native') {
      const handler = this.opts.nativeHandlers?.get(block.id)
      if (!handler) {
        throw new Error(`No native handler for block: ${block.id} (is its pack loaded?)`)
      }
      const out = await handler(ctx, resolvedInputs, params)
      return out ?? {}
    }

    // execution.type === 'workflow'
    const steps = block.execution.steps
    // Reject a (legacy/on-disk) workflow whose step id or `as` binding collides
    // with a typed $-ref root, rather than silently mis-resolving references.
    for (const s of steps) {
      if (RESERVED_REF_ROOTS.has(s.id)) {
        throw new Error(
          `workflow ${block.id}: step id "${s.id}" collides with the $${s.id} typed-reference root — re-author this workflow`,
        )
      }
      if (s.as !== undefined && RESERVED_REF_ROOTS.has(s.as)) {
        throw new Error(
          `workflow ${block.id}: step "${s.id}" as: "${s.as}" collides with the $${s.as} typed-reference root — re-author this workflow`,
        )
      }
    }
    const stepIndex = new Map(steps.map((s, i) => [s.id, i]))
    const stepOutputs: Record<string, Record<string, unknown>> = {}

    // A single ctx view + secrets, used identically for step inputs, conditions,
    // and the output mapping, so `{{ctx.*}}` / `{{secrets.*}}` resolve the same
    // everywhere. Secret values are redacted from the persisted report.
    const ctxView = { runId: ctx.runId, vars: ctx.vars }
    const secrets = ctx.secrets

    let current: string | null = steps[0]?.id ?? null
    let guard = 0
    let lastExecutedStepId: string | null = null

    while (current) {
      if (guard++ > STEP_LIMIT) {
        throw new Error('Step limit exceeded (possible infinite loop)')
      }
      const index = stepIndex.get(current)
      if (index === undefined) throw new Error(`Unknown step: ${current}`)
      const step = steps[index]!

      const child = this.registry.getBlock(step.block, step.version)
      if (!child) throw new Error(`Block not found in registry: ${step.block}`)

      // --- forEach branch ---------------------------------------------------
      if (step.forEach !== undefined) {
        const baseScope: ResolveScope = {
          inputs: resolvedInputs,
          params,
          ctx: ctxView,
          secrets,
          steps: stepOutputs,
        }
        const arrayVal = resolveTyped(step.forEach, baseScope)
        if (!Array.isArray(arrayVal)) {
          throw new Error(
            `forEach on step "${step.id}" must resolve to an array, got: ${JSON.stringify(arrayVal)}`,
          )
        }
        const loopName = step.as ?? 'item'
        const iterationOutputs: Record<string, unknown>[] = []
        for (let i = 0; i < arrayVal.length; i++) {
          // Each iteration increments the guard so a forEach over a huge array
          // can't bypass STEP_LIMIT.
          if (guard++ > STEP_LIMIT) {
            throw new Error('Step limit exceeded (possible infinite loop)')
          }
          const iterScope: ResolveScope = {
            ...baseScope,
            loopVar: { name: loopName, value: arrayVal[i] },
            loopIndex: i,
          }
          // Apply the child block's defaults here too so the recorded step trace
          // reflects the effective inputs the child runs with (execute re-applies
          // idempotently). Without this the trace would show pre-default inputs.
          const iterInputs = this.applyDefaults(child, resolveInputs(step.inputs, iterScope))
          const iterParams = step.params ? resolveInputs(step.params, iterScope) : undefined

          const trace: StepTrace = {
            seq: record.trace.length,
            stepId: step.id,
            block: step.block,
            status: 'RUNNING',
            // Snapshot: isolate the recorded inputs from in-place handler mutation.
            inputs: structuredClone(iterInputs),
            startedAt: nowIso(),
            iteration: i,
          }
          record.trace.push(trace)

          const prevStep = ctx.artifacts.currentStep
          // Use a unique per-iteration artifact namespace so artifacts from
          // different iterations don't collide.
          ctx.artifacts.setStep(`${step.id}[${i}]`)
          try {
            const out = await this.execute(child, iterInputs, ctx, record, iterParams)
            iterationOutputs.push(out)
            trace.outputs = out
            trace.status = 'COMPLETED'
            trace.endedAt = nowIso()
          } catch (err) {
            trace.status = 'FAILED'
            trace.error = err instanceof Error ? err.message : String(err)
            trace.endedAt = nowIso()
            throw err
          } finally {
            ctx.artifacts.setStep(prevStep)
          }
        }
        // Collect all iteration outputs under a single key so downstream steps
        // can reference $<stepId>.items as a typed array.
        stepOutputs[step.id] = { items: iterationOutputs }
        lastExecutedStepId = step.id

        // Control flow: forEach steps fall through to the next step by array
        // order. if/then/else/next are prohibited by validateDraft.
        current = this.nextStep(step, index, steps, {
          inputs: resolvedInputs,
          params,
          ctx: ctxView,
          secrets,
          steps: stepOutputs,
        })
        continue
      }
      // --- end forEach branch -----------------------------------------------

      const scope: ResolveScope = {
        inputs: resolvedInputs,
        params,
        ctx: ctxView,
        secrets,
        steps: stepOutputs,
      }
      // Apply the child block's defaults so the step trace records the effective
      // inputs (incl. defaults), matching what the child actually executes with.
      const stepInputs = this.applyDefaults(child, resolveInputs(step.inputs, scope))
      const stepParams = step.params ? resolveInputs(step.params, scope) : undefined

      const trace: StepTrace = {
        seq: record.trace.length,
        stepId: step.id,
        block: step.block,
        status: 'RUNNING',
        // Snapshot: isolate the recorded inputs from in-place handler mutation.
        inputs: structuredClone(stepInputs),
        startedAt: nowIso(),
      }
      record.trace.push(trace)

      const prevStep = ctx.artifacts.currentStep
      ctx.artifacts.setStep(step.id)
      try {
        const out = await this.execute(child, stepInputs, ctx, record, stepParams)
        stepOutputs[step.id] = out
        lastExecutedStepId = step.id
        trace.outputs = out
        trace.status = 'COMPLETED'
        trace.endedAt = nowIso()
      } catch (err) {
        trace.status = 'FAILED'
        trace.error = err instanceof Error ? err.message : String(err)
        trace.endedAt = nowIso()
        throw err
      } finally {
        ctx.artifacts.setStep(prevStep)
      }

      current = this.nextStep(step, index, steps, {
        inputs: resolvedInputs,
        params,
        ctx: ctxView,
        secrets,
        steps: stepOutputs,
      })
    }

    return this.mapOutputs(block, resolvedInputs, params, ctxView, secrets, stepOutputs, lastExecutedStepId)
  }

  /** Decide the next step id: conditional jump, explicit next, or fall through. */
  private nextStep(
    step: WorkflowStep,
    index: number,
    steps: WorkflowStep[],
    scope: ResolveScope,
  ): string | null {
    if (step.if) {
      const truthy = evalCondition(step.if, scope)
      return (truthy ? step.then : step.else) ?? null
    }
    if (step.next) return step.next
    return steps[index + 1]?.id ?? null
  }

  /** Shape the workflow's public outputs. */
  private mapOutputs(
    block: BlockDefinition,
    inputs: Record<string, unknown>,
    params: Record<string, unknown> | undefined,
    ctxView: Record<string, unknown>,
    secrets: Record<string, string>,
    stepOutputs: Record<string, Record<string, unknown>>,
    lastExecutedStepId: string | null,
  ): Record<string, unknown> {
    if (block.execution.type !== 'workflow') return {}
    const mapping = block.execution.outputMapping
    if (mapping) {
      const scope: ResolveScope = { inputs, params, ctx: ctxView, secrets, steps: stepOutputs }
      const out: Record<string, unknown> = {}
      for (const [k, expr] of Object.entries(mapping)) {
        out[k] = resolveValue(expr, scope)
      }
      return out
    }
    // Default: the last EXECUTED step's outputs, keyed by the step that actually
    // ran last — not array position. This is correct for branching and polling
    // workflows where the exit step may not be the last-declared step. An
    // empty-array forEach is still "executed" (it wrote stepOutputs) so
    // lastExecutedStepId points at it, returning { items: [] } correctly.
    if (lastExecutedStepId !== null) {
      return stepOutputs[lastExecutedStepId] ?? {}
    }
    return {}
  }

  /** Pin every referenced definition so the run record is reproducible. */
  private buildSnapshot(root: BlockDefinition): ExecutionSnapshot {
    const blocks: Record<string, BlockDefinition> = {}
    const visit = (b: BlockDefinition) => {
      if (b.execution.type !== 'workflow') return
      for (const step of b.execution.steps) {
        if (blocks[step.block]) continue
        const child = this.registry.getBlock(step.block, step.version)
        if (child) {
          blocks[step.block] = child
          visit(child)
        }
      }
    }
    visit(root)
    return { root, blocks }
  }
}
