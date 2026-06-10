import { z } from 'zod'

/**
 * Core data model for the runtime.
 *
 * Carried forward from the legacy `aa` codebase: the single best idea there was
 * that a *workflow is just a Block whose `execution.type === 'workflow'`*. One
 * recursive abstraction, one registry, one `run()`. We keep that, but:
 *   - the model is now a set of zod schemas (validated, not prose-in-a-prompt);
 *   - a step's `inputs` (data to process) and `params` (behavior config) are
 *     separated, and `ctx` (the runtime world) is a separate object entirely —
 *     the `inputs ≠ params ≠ ctx` rule from the strategy report;
 *   - the execution trace is an *ordered array* (the legacy id-keyed Record lost
 *     ordering and could not represent a step running twice).
 */

/** A declared input/output field on a block. */
export const FieldSchema = z.object({
  name: z.string(),
  type: z.string().default('any'),
  description: z.string().optional(),
  required: z.boolean().optional(),
  /**
   * Safe-interface constraints, enforced by the engine on every run. They make
   * unsafe values unrepresentable — e.g. a kubectl block whose `namespace`
   * input has `enum: ["dev", "staging"]` cannot be pointed at prod, no matter
   * what calls it. `pattern` is a full-match regex applied to string values.
   */
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  pattern: z.string().optional(),
})
export type Field = z.infer<typeof FieldSchema>

/** One step in a workflow: invoke a block, wire its inputs, optionally branch. */
export const WorkflowStepSchema = z.object({
  id: z.string(),
  /** Block id to invoke (legacy called this `block_id`). */
  block: z.string(),
  version: z.string().optional(),
  /** Data the block operates on. Values may use {{interp}} / $step refs. */
  inputs: z.record(z.unknown()).default({}),
  /** Behavior configuration for the block (separate from data). */
  params: z.record(z.unknown()).optional(),
  // --- declarative control flow, evaluated against { inputs, steps } ---
  /** Safe boolean expression; on true jump to `then`, else `else`. */
  if: z.string().optional(),
  then: z.string().optional(),
  else: z.string().optional(),
  /** Explicit next step id; absent control flow falls through by array order. */
  next: z.string().optional(),
})
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

export const NodeExecutionSchema = z.object({
  type: z.literal('node'),
  code: z.string(),
  dependencies: z.array(z.string()).optional(),
})

export const WorkflowExecutionSchema = z.object({
  type: z.literal('workflow'),
  steps: z.array(WorkflowStepSchema),
  /** Map a workflow's public outputs from internal step outputs. */
  outputMapping: z.record(z.string()).optional(),
})

/**
 * A built-in block provided by a pack. The definition is serializable (so it
 * shows up in the catalog and can be referenced by id); the actual handler is
 * supplied in code by the pack, looked up by block id at run time. Pack blocks
 * are not written to the user's `.aa` registry — they ship with the runtime.
 */
export const NativeExecutionSchema = z.object({
  type: z.literal('native'),
})

/**
 * A governed host command. The binary and argv TEMPLATE are part of the
 * definition the user approves — inputs interpolate into individual argv
 * slots only (spawned without a shell), so what the user approved is a
 * specific command SHAPE, not blanket shell access. Every execution lands
 * in run history with stdout/stderr/exitCode for auditing.
 */
export const CommandExecutionSchema = z.object({
  type: z.literal('command'),
  /** The binary to run. Fixed — interpolation here is rejected at validation. */
  command: z.string(),
  /** Argv template; entries may use {{inputs.x}} / {{params.x}} / {{secrets.X}}. */
  args: z.array(z.string()).default([]),
  /** Working dir, workspace-relative. Fixed string (no interpolation). */
  cwd: z.string().optional(),
  /** Extra env vars; values may interpolate (e.g. TOKEN: "{{secrets.GH_TOKEN}}"). */
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().optional(),
  /** Default true: non-zero exit fails the step. Set false to branch on exitCode. */
  failOnError: z.boolean().optional(),
})

export const ExecutionSchema = z.discriminatedUnion('type', [
  NodeExecutionSchema,
  WorkflowExecutionSchema,
  NativeExecutionSchema,
  CommandExecutionSchema,
])
export type Execution = z.infer<typeof ExecutionSchema>

export const BlockDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().default('0.1.0'),
  description: z.string().optional(),
  /** Capabilities this block requires from the runtime (e.g. "browser"). */
  capabilities: z.array(z.string()).optional(),
  inputs: z.array(FieldSchema).default([]),
  outputs: z.array(FieldSchema).default([]),
  execution: ExecutionSchema,
  /** Provenance: which model drafted this artifact, if any. */
  generatedByModel: z.string().optional(),
  /**
   * Governance state. Registration always lands as 'draft'; only the user
   * promotes to 'approved'. Absent ⇒ treated as draft.
   */
  approval: z.enum(['draft', 'approved', 'deprecated']).optional(),
})
export type BlockDefinition = z.infer<typeof BlockDefinitionSchema>

export type RunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'

/** One entry in the ordered execution trace. */
export interface StepTrace {
  seq: number
  stepId: string
  block: string
  status: RunStatus
  inputs: Record<string, unknown>
  outputs?: Record<string, unknown>
  error?: string
  startedAt: string
  endedAt?: string
}

/**
 * Pinned, self-contained copy of every definition used by a run, so the run
 * record stays reproducible/inspectable even after the live blocks change.
 */
export interface ExecutionSnapshot {
  root: BlockDefinition
  blocks: Record<string, BlockDefinition>
}

/**
 * The authoritative run record == the structured evidence report.
 * Persisted to `.aa/runs/<runId>/run.json`. "Reports prove it."
 */
export interface RunRecord {
  runId: string
  blockId: string
  status: RunStatus
  /** Whether the executed definition (and its refs) were user-approved. A
   *  `false` here means the run was a one-time `--yes` user override. */
  approved?: boolean
  inputs: Record<string, unknown>
  params?: Record<string, unknown>
  results?: Record<string, unknown>
  error?: string
  trace: StepTrace[]
  snapshot: ExecutionSnapshot
  artifacts: string[]
  startedAt: string
  endedAt?: string
}
