import { resolveInputs, resolveValue, evalCondition, type ResolveScope } from './resolver'
import { runNodeBlock } from './executor'
import type { ExecutionContext } from './context'
import type { Registry } from '../registry/file-registry'
import type {
  BlockDefinition,
  ExecutionSnapshot,
  RunRecord,
  StepTrace,
  WorkflowStep,
} from './types'

const nowIso = () => new Date().toISOString()
const STEP_LIMIT = 10_000

export interface EngineOptions {
  timeoutMs?: number
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
    const record: RunRecord = {
      runId: ctx.runId,
      blockId: root.id,
      status: 'RUNNING',
      inputs,
      params,
      trace: [],
      snapshot: this.buildSnapshot(root),
      artifacts: [],
      startedAt: nowIso(),
    }

    try {
      record.results = await this.execute(root, inputs, ctx, record, params)
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
  private async execute(
    block: BlockDefinition,
    inputs: Record<string, unknown>,
    ctx: ExecutionContext,
    record: RunRecord,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (block.execution.type === 'node') {
      const res = await runNodeBlock(block.execution.code, inputs, ctx, {
        timeoutMs: this.opts.timeoutMs,
      })
      for (const line of res.logs) ctx.logger.debug(`[${block.id}] ${line}`)
      return res.output
    }

    // execution.type === 'workflow'
    const steps = block.execution.steps
    const stepIndex = new Map(steps.map((s, i) => [s.id, i]))
    const stepOutputs: Record<string, Record<string, unknown>> = {}

    let current: string | null = steps[0]?.id ?? null
    let guard = 0

    while (current) {
      if (guard++ > STEP_LIMIT) {
        throw new Error('Step limit exceeded (possible infinite loop)')
      }
      const index = stepIndex.get(current)
      if (index === undefined) throw new Error(`Unknown step: ${current}`)
      const step = steps[index]!

      const child = this.registry.getBlock(step.block, step.version)
      if (!child) throw new Error(`Block not found in registry: ${step.block}`)

      const scope: ResolveScope = {
        inputs,
        params,
        ctx: { runId: ctx.runId, vars: ctx.vars },
        steps: stepOutputs,
      }
      const stepInputs = resolveInputs(step.inputs, scope)
      const stepParams = step.params ? resolveInputs(step.params, scope) : undefined

      const trace: StepTrace = {
        seq: record.trace.length,
        stepId: step.id,
        block: step.block,
        status: 'RUNNING',
        inputs: stepInputs,
        startedAt: nowIso(),
      }
      record.trace.push(trace)

      try {
        const out = await this.execute(child, stepInputs, ctx, record, stepParams)
        stepOutputs[step.id] = out
        trace.outputs = out
        trace.status = 'COMPLETED'
        trace.endedAt = nowIso()
      } catch (err) {
        trace.status = 'FAILED'
        trace.error = err instanceof Error ? err.message : String(err)
        trace.endedAt = nowIso()
        throw err
      }

      current = this.nextStep(step, index, steps, { inputs, steps: stepOutputs })
    }

    return this.mapOutputs(block, inputs, params, stepOutputs, record)
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
    stepOutputs: Record<string, Record<string, unknown>>,
    record: RunRecord,
  ): Record<string, unknown> {
    if (block.execution.type !== 'workflow') return {}
    const mapping = block.execution.outputMapping
    if (mapping) {
      const scope: ResolveScope = { inputs, params, steps: stepOutputs }
      const out: Record<string, unknown> = {}
      for (const [k, expr] of Object.entries(mapping)) {
        out[k] = resolveValue(expr, scope)
      }
      return out
    }
    // Default: the last completed step's outputs (explicit, not key-order based).
    const last = record.trace[record.trace.length - 1]
    return last ? (stepOutputs[last.stepId] ?? {}) : {}
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
