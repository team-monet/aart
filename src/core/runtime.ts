import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Engine } from './engine'
import { createContext, createLogger } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { writeRun, runDir } from './report'
import { FileRegistry, type Registry } from '../registry/file-registry'
import { CompositeRegistry } from '../pack/composite-registry'
import type { Capability, NativeRunFn, Pack } from '../pack/types'
import type { BlockDefinition, RunRecord } from './types'

const nowIso = () => new Date().toISOString()

/** Collect the capabilities a definition (and everything it references) needs. */
export function collectCapabilities(def: BlockDefinition, registry: Registry): Set<string> {
  const caps = new Set<string>()
  const seen = new Set<string>()
  const visit = (b: BlockDefinition) => {
    if (seen.has(b.id)) return
    seen.add(b.id)
    for (const c of b.capabilities ?? []) caps.add(c)
    if (b.execution.type === 'workflow') {
      for (const step of b.execution.steps) {
        const child = registry.getBlock(step.block, step.version)
        if (child) visit(child)
      }
    }
  }
  visit(def)
  return caps
}

/**
 * Holds the loaded packs, the composite registry (built-in pack blocks + the
 * user's file registry), and runs definitions with the per-run capability
 * lifecycle. CLI and MCP both go through a Runtime so behavior is identical.
 */
export class Runtime {
  readonly fileRegistry: FileRegistry
  readonly registry: CompositeRegistry
  private nativeHandlers: Map<string, NativeRunFn>
  private capabilities: Map<string, Capability>

  constructor(
    private workspace: string,
    packs: Pack[] = [],
  ) {
    this.fileRegistry = new FileRegistry(path.join(workspace, '.aa', 'registry'))
    this.registry = new CompositeRegistry(
      this.fileRegistry,
      packs.flatMap((p) => p.blocks),
    )
    this.nativeHandlers = this.registry.nativeHandlers()
    this.capabilities = new Map(
      packs.flatMap((p) => p.capabilities).map((c) => [c.name, c]),
    )
  }

  async run(
    def: BlockDefinition,
    inputs: Record<string, unknown>,
    params?: Record<string, unknown>,
    opts: { verbose?: boolean; timeoutMs?: number } = {},
  ): Promise<RunRecord> {
    const runId = randomUUID()
    const artifacts = new ArtifactStore(runDir(this.workspace, runId))
    const ctx = createContext({
      runId,
      workspace: this.workspace,
      artifacts,
      logger: createLogger(opts.verbose),
    })

    const needed = collectCapabilities(def, this.registry)
    const active: Capability[] = []

    try {
      for (const name of needed) {
        const provider = this.capabilities.get(name)
        if (!provider) throw new Error(`No provider for capability "${name}"`)
        ctx.capabilities[name] = await provider.setup(ctx)
        active.push(provider)
      }
    } catch (err) {
      await this.teardown(active, ctx)
      const record = failedRecord(def, inputs, params, runId, ctx.artifacts.list(), `capability setup failed: ${
        err instanceof Error ? err.message : String(err)
      }`)
      await writeRun(this.workspace, record)
      return record
    }

    // Engine.run catches block failures internally and returns a FAILED record.
    const record = await new Engine(this.registry, {
      nativeHandlers: this.nativeHandlers,
      timeoutMs: opts.timeoutMs,
    }).run(def, inputs, ctx, params)

    await this.teardown(active, ctx)
    await writeRun(this.workspace, record)
    return record
  }

  private async teardown(active: Capability[], ctx: Parameters<Capability['teardown']>[1]): Promise<void> {
    for (const cap of [...active].reverse()) {
      try {
        await cap.teardown(ctx.capabilities[cap.name], ctx)
      } catch (err) {
        ctx.logger.warn(`teardown of "${cap.name}" failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

function failedRecord(
  def: BlockDefinition,
  inputs: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  runId: string,
  artifacts: string[],
  error: string,
): RunRecord {
  const now = nowIso()
  return {
    runId,
    blockId: def.id,
    status: 'FAILED',
    inputs,
    params,
    error,
    trace: [],
    snapshot: { root: def, blocks: {} },
    artifacts,
    startedAt: now,
    endedAt: now,
  }
}
