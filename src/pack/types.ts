import type { BlockDefinition } from '../core/types'
import type { ExecutionContext } from '../core/context'

/** A native block's run function. Inputs/params are already resolved. */
export type NativeRunFn = (
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>

/** A built-in block: a serializable definition plus its code handler. */
export interface NativeBlock {
  def: BlockDefinition // execution.type === 'native'
  run: NativeRunFn
}

/**
 * A capability is a resource the runtime sets up once per run and tears down
 * after, placed in `ctx.capabilities[name]`. Packs provide them; the core never
 * hard-codes a domain capability. Only capabilities a run actually needs (per
 * the blocks' declared `capabilities`) are set up.
 */
export interface Capability {
  name: string
  setup: (ctx: ExecutionContext) => Promise<unknown>
  teardown: (value: unknown, ctx: ExecutionContext) => Promise<void>
}

/** A pack bundles built-in blocks and the capabilities they need. */
export interface Pack {
  name: string
  blocks: NativeBlock[]
  capabilities: Capability[]
  /** Legacy id → current id. Old ids keep resolving after a rename. */
  aliases?: Record<string, string>
  /**
   * Pre-approved workflow definitions shipped with the pack. These are
   * data-only `BlockDefinition` values whose `execution.type === 'workflow'`.
   * The registry stamps each with `approval: 'approved'` at load time so they
   * are catalog-visible and bypass the approval gate, exactly like native
   * blocks. Authors do NOT need to set `approval` by hand; the runtime sets it
   * unconditionally based on trusted origin (pack-shipped = trusted).
   */
  workflows?: BlockDefinition[]
  /**
   * Pre-approved command block definitions shipped with the pack. These are
   * data-only `BlockDefinition` values whose `execution.type === 'command'`.
   * The registry stamps each with `approval: 'approved'` at load time, so they
   * run without --yes and appear in the catalog exactly like pack workflows.
   *
   * Safety comes from a FIXED command/argv shape, enum/pattern input
   * constraints, read-only operations, and the command-runner's full
   * stdout/stderr/exitCode audit trail persisted to run history.
   */
  commands?: BlockDefinition[]
}

/** Helper to declare a native block with a `native` execution type. */
export function nativeBlock(
  def: Omit<BlockDefinition, 'execution'> & { execution?: never },
  run: NativeRunFn,
): NativeBlock {
  return { def: { ...def, execution: { type: 'native' } }, run }
}
