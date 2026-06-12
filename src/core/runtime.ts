import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Engine } from './engine'
import { createContext, createLogger } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { writeRun, runDir } from './report'
import { loadSecrets, redactRecord } from './secrets'
import { FileRegistry, type Registry } from '../registry/file-registry'
import { CompositeRegistry } from '../pack/composite-registry'
import type { Capability, NativeRunFn, Pack } from '../pack/types'
import type { ArtifactMeta, BlockDefinition, RunRecord } from './types'

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
  /** What each loaded pack contributed (by pack name), for replacement on re-approval. */
  private packBlocks = new Map<string, string[]>()
  private packCaps = new Map<string, string[]>()

  constructor(
    private workspace: string,
    packs: Pack[] = [],
  ) {
    this.fileRegistry = new FileRegistry(path.join(workspace, '.aa', 'registry'))
    this.registry = new CompositeRegistry(
      this.fileRegistry,
      packs.flatMap((p) => p.blocks),
      new Map(packs.flatMap((p) => Object.entries(p.aliases ?? {}))),
    )
    this.nativeHandlers = this.registry.nativeHandlers()
    this.capabilities = new Map()
    for (const c of packs.flatMap((p) => p.capabilities)) {
      if (this.capabilities.has(c.name)) {
        throw new Error(`Duplicate capability name across packs: ${c.name}`)
      }
      this.capabilities.set(c.name, c)
    }
    for (const p of packs) {
      this.packBlocks.set(p.name, p.blocks.map((b) => b.def.id))
      this.packCaps.set(p.name, p.capabilities.map((c) => c.name))
    }
  }

  /**
   * Hot-add a pack to a live Runtime (used when the user approves a workspace
   * pack mid-session, so it is usable without a server restart). Re-adding a
   * pack with the same name REPLACES its earlier contribution (re-approval
   * after an edit); collisions with OTHER packs are validated up front so a
   * partial add cannot happen.
   */
  addPack(pack: Pack): void {
    const ownBlocks = new Set(this.packBlocks.get(pack.name) ?? [])
    const ownCaps = new Set(this.packCaps.get(pack.name) ?? [])
    for (const b of pack.blocks) {
      if (!ownBlocks.has(b.def.id) && this.registry.getBlock(b.def.id)?.execution.type === 'native') {
        throw new Error(`pack "${pack.name}": block id "${b.def.id}" is already provided by another pack`)
      }
    }
    for (const c of pack.capabilities) {
      if (!ownCaps.has(c.name) && this.capabilities.has(c.name)) {
        throw new Error(`pack "${pack.name}": capability "${c.name}" is already provided by another pack`)
      }
    }
    for (const id of ownBlocks) {
      this.registry.removeNativeBlock(id)
      this.nativeHandlers.delete(id)
    }
    for (const name of ownCaps) this.capabilities.delete(name)
    for (const b of pack.blocks) {
      this.registry.addNativeBlock(b)
      this.nativeHandlers.set(b.def.id, b.run)
    }
    for (const c of pack.capabilities) this.capabilities.set(c.name, c)
    this.packBlocks.set(pack.name, pack.blocks.map((b) => b.def.id))
    this.packCaps.set(pack.name, pack.capabilities.map((c) => c.name))
  }

  async run(
    def: BlockDefinition,
    inputs: Record<string, unknown>,
    params?: Record<string, unknown>,
    opts: { verbose?: boolean; timeoutMs?: number; approved?: boolean } = {},
  ): Promise<RunRecord> {
    const approved = opts.approved ?? true
    const runId = randomUUID()
    const artifacts = new ArtifactStore(runDir(this.workspace, runId))
    const secrets = loadSecrets(this.workspace)
    const ctx = createContext({
      runId,
      workspace: this.workspace,
      artifacts,
      secrets,
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
      const failed = failedRecord(def, inputs, params, runId, ctx.artifacts.list(), `capability setup failed: ${
        err instanceof Error ? err.message : String(err)
      }`)
      failed.approved = approved
      const record = redactRecord(failed, secrets)
      await this.persist(record, ctx)
      return record
    }

    // teardown in finally so a capability (e.g. a Chromium process) is always
    // released, even if the engine path or persistence throws.
    try {
      // Engine.run catches block failures internally and returns a FAILED record.
      const raw = await new Engine(this.registry, {
        nativeHandlers: this.nativeHandlers,
        timeoutMs: opts.timeoutMs,
      }).run(def, inputs, ctx, params)
      raw.approved = approved
      // Mask secret values before anything is persisted, printed, or returned.
      const record = redactRecord(raw, secrets)
      await this.persist(record, ctx)
      return record
    } finally {
      await this.teardown(active, ctx)
    }
  }

  /** Persist the run record; a disk fault must not lose the in-memory evidence. */
  private async persist(record: RunRecord, ctx: { logger: { warn: (m: string) => void } }): Promise<void> {
    try {
      await writeRun(this.workspace, record)
    } catch (err) {
      ctx.logger.warn(
        `failed to persist run ${record.runId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
  artifacts: ArtifactMeta[],
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
