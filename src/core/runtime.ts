import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Engine } from './engine'
import { createContext, createLogger } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { writeRun, runDir } from './report'
import { loadSecrets, redactRecord, SecretCollisionError } from './secrets'
import { notify } from './notify'
import { approvalEnforced } from './approval'
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
  private packWfs = new Map<string, string[]>()
  private packCmds = new Map<string, string[]>()

  constructor(
    private workspace: string,
    packs: Pack[] = [],
  ) {
    this.fileRegistry = new FileRegistry(path.join(workspace, '.aa', 'registry'))
    this.registry = new CompositeRegistry(
      this.fileRegistry,
      packs.flatMap((p) => p.blocks),
      new Map(packs.flatMap((p) => Object.entries(p.aliases ?? {}))),
      packs.flatMap((p) => p.workflows ?? []),
      packs.flatMap((p) => p.commands ?? []),
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
      this.packWfs.set(p.name, (p.workflows ?? []).map((w) => w.id))
      this.packCmds.set(p.name, (p.commands ?? []).map((c) => c.id))
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
    const ownWfs = new Set(this.packWfs.get(pack.name) ?? [])
    const ownCmds = new Set(this.packCmds.get(pack.name) ?? [])
    for (const b of pack.blocks) {
      if (ownBlocks.has(b.def.id)) continue
      // Reject a block that collides with an existing native block OR a built-in
      // pack workflow. Without the pack-workflow check a native block named like
      // a built-in workflow (e.g. http.health-check) would be accepted here and
      // shadow that workflow in the live runtime (getBlock resolves native first)
      // until a restart, where mergePacks would skip it — an inconsistency.
      if (
        this.registry.getBlock(b.def.id)?.execution.type === 'native' ||
        this.registry.isPackWorkflow(b.def.id)
      ) {
        throw new Error(
          `pack "${pack.name}": block id "${b.def.id}" is already provided by a built-in block or workflow`,
        )
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
    for (const id of ownWfs) this.registry.removePackWorkflow(id)
    for (const id of ownCmds) this.registry.removePackCommand(id)
    for (const name of ownCaps) this.capabilities.delete(name)
    for (const b of pack.blocks) {
      this.registry.addNativeBlock(b)
      this.nativeHandlers.set(b.def.id, b.run)
    }
    if (pack.workflows?.length) {
      this.registry.addPackWorkflows(pack.workflows)
    }
    if (pack.commands?.length) {
      this.registry.addPackCommands(pack.commands)
    }
    for (const c of pack.capabilities) this.capabilities.set(c.name, c)
    this.packBlocks.set(pack.name, pack.blocks.map((b) => b.def.id))
    this.packCaps.set(pack.name, pack.capabilities.map((c) => c.name))
    this.packWfs.set(pack.name, (pack.workflows ?? []).map((w) => w.id))
    this.packCmds.set(pack.name, (pack.commands ?? []).map((c) => c.id))
  }

  async run(
    def: BlockDefinition,
    inputs: Record<string, unknown>,
    params?: Record<string, unknown>,
    opts: { verbose?: boolean; timeoutMs?: number; approved?: boolean; deprecated?: boolean } = {},
  ): Promise<RunRecord> {
    const approved = opts.approved ?? true
    const deprecatedRun = opts.deprecated ?? false
    // Capture enforcement state ONCE at run start — rendering later must not
    // re-read the live env (that would mislabel historical records).
    const enforcedAtStart = approvalEnforced()
    const runId = randomUUID()
    const artifacts = new ArtifactStore(runDir(this.workspace, runId))
    let secrets: Record<string, string>
    try {
      secrets = loadSecrets(this.workspace)
    } catch (err) {
      // Only handle typed collision errors here — any other error (e.g. a future
      // loadSecrets code path) is unexpected and should propagate.
      if (!(err instanceof SecretCollisionError)) throw err
      // A SecretCollisionError is a config error: produce a proper FAILED record.
      // Redacting with an empty map is safe here because collision messages contain
      // key NAMES only, no secret values.
      const logger = createLogger(opts.verbose)
      const failed = failedRecord(def, inputs, params, runId, [], `secrets load failed: ${err.message}`)
      failed.approved = opts.approved ?? true
      failed.approvalEnforced = approvalEnforced()
      failed.deprecated = opts.deprecated ?? false
      const record = redactRecord(failed, {})
      await this.persist(record, { logger })
      try { await notify(this.workspace, record, {}, logger) } catch (e) {
        logger.warn(`aart notify: unexpected error: ${e instanceof Error ? e.message : String(e)}`)
      }
      return record
    }
    const ctx = createContext({
      runId,
      workspace: this.workspace,
      artifacts,
      secrets,
      logger: createLogger(opts.verbose),
    })

    // Phase 1: persist a redacted RUNNING record BEFORE capability setup (the
    // Chromium-launch step is the most crash-prone), so a hard crash mid-run
    // still leaves visible evidence the run started. The terminal record below
    // overwrites it; a phase-1 disk fault must not abort the run (persist warns).
    await this.persist(redactRecord(initialRecord(def, inputs, params, runId, approved, enforcedAtStart, deprecatedRun), secrets), ctx)

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
      failed.approvalEnforced = enforcedAtStart
      failed.deprecated = deprecatedRun
      const record = redactRecord(failed, secrets)
      await this.persist(record, ctx)
      try { await notify(this.workspace, record, secrets, ctx.logger) } catch (e) {
        ctx.logger.warn(`aart notify: unexpected error: ${e instanceof Error ? e.message : String(e)}`)
      }
      return record
    }

    // teardown in finally so a capability (e.g. a Chromium process) is always
    // released, even if the engine path or persistence throws.
    let record: RunRecord | undefined
    try {
      // Engine.run catches block failures internally and returns a FAILED record.
      const raw = await new Engine(this.registry, {
        nativeHandlers: this.nativeHandlers,
        timeoutMs: opts.timeoutMs,
      }).run(def, inputs, ctx, params)
      raw.approved = approved
      raw.approvalEnforced = enforcedAtStart
      raw.deprecated = deprecatedRun
      // Mask secret values before anything is persisted, printed, or returned.
      record = redactRecord(raw, secrets)
      await this.persist(record, ctx)
    } finally {
      // Teardown may attach artifacts (e.g. browser console/network JSON). Run
      // it unconditionally; only a capability's teardown can add artifacts, so
      // re-snapshot + re-persist only when one was active. Re-REDACT, since an
      // artifact name can carry a secret value (e.g. a user-named screenshot).
      await this.teardown(active, ctx)
      if (record && active.length) {
        record = redactRecord({ ...record, artifacts: ctx.artifacts.list() }, secrets)
        await this.persist(record, ctx)
      }
    }
    // record is always set here: Engine.run either completes or fails (never
    // throws past the engine boundary); if it did throw, teardown still ran and
    // we'd have thrown out of the finally — so reaching here means record is set.
    //
    // Fire the notification AFTER the record is final and persisted. Do NOT put
    // this inside the finally (it must not interfere with teardown). Belt-and-
    // suspenders try/catch even though notify() is internally guarded.
    try { await notify(this.workspace, record!, secrets, ctx.logger) } catch (e) {
      ctx.logger.warn(`aart notify: unexpected error: ${e instanceof Error ? e.message : String(e)}`)
    }
    return record!
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

/** The phase-1 RUNNING record, written before the engine runs (crash visibility). */
function initialRecord(
  def: BlockDefinition,
  inputs: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  runId: string,
  approved: boolean,
  enforcedAtStart: boolean,
  deprecated: boolean,
): RunRecord {
  return {
    runId,
    blockId: def.id,
    status: 'RUNNING',
    approved,
    approvalEnforced: enforcedAtStart,
    deprecated,
    inputs,
    params,
    trace: [],
    snapshot: { root: def, blocks: {} },
    artifacts: [],
    startedAt: nowIso(),
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
