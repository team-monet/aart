import type { BlockDefinition } from '../core/types'
import type { Registry } from '../registry/file-registry'
import type { NativeBlock, NativeRunFn } from './types'

/**
 * Read/run view over built-in pack blocks layered on top of the user's file
 * registry. Pack (native) blocks take precedence and are never written to disk;
 * writes (registerBlock/deleteBlock) always go to the file registry. The engine
 * uses `nativeHandlers()` to execute native blocks.
 *
 * Pack workflows and pack commands occupy a slot between native blocks and the
 * file registry:
 *   native block id → pack pre-approved def id → file registry id
 * A native block id always wins a collision with a pack def id (error at load
 * time so pack authors catch it early). Pack def ids are stamped
 * `approval: 'approved'` at load time — trusted by origin, same rationale as
 * native blocks.
 */
export class CompositeRegistry implements Registry {
  private native = new Map<string, NativeBlock>()
  /**
   * Pack-shipped pre-approved definitions (workflows + commands), stamped
   * approved at load time.
   * Resolution order: native > packDef > file.
   */
  private packDefs = new Map<string, BlockDefinition>()
  /** Legacy id → current id (e.g. the pre-rename `qa.*` ids). Never removed. */
  private aliases: Map<string, string>

  constructor(
    private file: Registry,
    nativeBlocks: NativeBlock[] = [],
    aliases: Map<string, string> = new Map(),
    packWorkflowDefs: BlockDefinition[] = [],
    packCommandDefs: BlockDefinition[] = [],
  ) {
    this.aliases = aliases
    for (const b of nativeBlocks) {
      if (this.native.has(b.def.id)) {
        throw new Error(`Duplicate native block id across packs: ${b.def.id}`)
      }
      this.native.set(b.def.id, b)
    }
    for (const wf of packWorkflowDefs) {
      this._loadPackDef(wf, 'workflow')
    }
    for (const cmd of packCommandDefs) {
      this._loadPackDef(cmd, 'command')
    }
  }

  /**
   * Stamp and register a single pack pre-approved definition.
   * `expectedType` enforces that workflows[] entries have execution.type===
   * 'workflow' and commands[] entries have execution.type==='command', so the
   * two fields cannot be accidentally misused.
   */
  private _loadPackDef(def: BlockDefinition, expectedType: 'workflow' | 'command'): void {
    if (def.execution.type !== expectedType) {
      throw new Error(
        `Pack ${expectedType} entry "${def.id}" has execution.type="${def.execution.type}" — expected "${expectedType}"`,
      )
    }
    if (this.native.has(def.id)) {
      throw new Error(
        `Pack ${expectedType} id "${def.id}" collides with a native block id — rename the ${expectedType}`,
      )
    }
    if (this.packDefs.has(def.id)) {
      throw new Error(`Duplicate pack ${expectedType} id: ${def.id}`)
    }
    // Stamp approval unconditionally — trusted by origin (pack-shipped).
    // First-party command blocks are pre-approved by ORIGIN (like native blocks
    // and pack workflows) — the safety comes from a FIXED command/argv shape,
    // enum/pattern input constraints, read-only operations, and the
    // command-runner's full stdout/stderr/exitCode audit trail in run history.
    this.packDefs.set(def.id, { ...def, approval: 'approved' })
  }

  getBlock(id: string, version?: string): BlockDefinition | undefined {
    const n = this.native.get(id) ?? this.native.get(this.aliases.get(id) ?? '')
    // Honor a version pin: a pin that doesn't match the native block falls
    // through to the file registry (and ultimately resolves to undefined),
    // matching FileRegistry semantics so bad pins are rejected at validation.
    if (n && (version === undefined || version === 'latest' || version === n.def.version)) {
      return n.def
    }
    // Pack pre-approved defs (workflows + commands): same version-pin semantics.
    const pd = this.packDefs.get(id)
    if (pd && (version === undefined || version === 'latest' || version === pd.version)) {
      // Return a copy: a caller that mutates the result (e.g. setApproval/deprecate
      // before registerBlock rejects the write) must not be able to corrupt the
      // stored built-in def, which would otherwise persist until restart.
      return { ...pd }
    }
    return this.file.getBlock(id, version)
  }

  listBlocks(): BlockDefinition[] {
    const out = [...this.native.values()].map((b) => b.def)
    const nativeIds = new Set(this.native.keys())
    // Pack defs listed after native blocks; shadowed by native ids (already guarded above).
    for (const pd of this.packDefs.values()) {
      if (!nativeIds.has(pd.id)) out.push(pd)
    }
    const reservedIds = new Set([...nativeIds, ...this.packDefs.keys()])
    for (const b of this.file.listBlocks()) {
      if (!reservedIds.has(b.id)) out.push(b)
    }
    return out
  }

  registerBlock(block: BlockDefinition): void {
    if (this.native.has(block.id)) {
      throw new Error(`Cannot overwrite built-in pack block: ${block.id}`)
    }
    if (this.packDefs.has(block.id)) {
      const existing = this.packDefs.get(block.id)!
      const kind = existing.execution.type === 'workflow' ? 'workflow' : 'command block'
      throw new Error(`Cannot overwrite built-in pack ${kind}: ${block.id}`)
    }
    const target = this.aliases.get(block.id)
    if (target && this.native.has(target)) {
      throw new Error(`Cannot register ${block.id}: it is a legacy alias of ${target}`)
    }
    this.file.registerBlock(block)
  }

  deleteBlock(id: string): void {
    if (this.native.has(id)) {
      throw new Error(`Cannot delete built-in pack block: ${id}`)
    }
    if (this.packDefs.has(id)) {
      const existing = this.packDefs.get(id)!
      const kind = existing.execution.type === 'workflow' ? 'workflow' : 'command block'
      throw new Error(`Cannot delete built-in pack ${kind}: ${id}`)
    }
    this.file.deleteBlock(id)
  }

  /** Add a native block after construction (workspace pack hot-load). */
  addNativeBlock(b: NativeBlock): void {
    if (this.native.has(b.def.id)) {
      throw new Error(`Duplicate native block id across packs: ${b.def.id}`)
    }
    const target = this.aliases.get(b.def.id)
    if (target && this.native.has(target)) {
      throw new Error(`Block id ${b.def.id} is a legacy alias of ${target}`)
    }
    this.native.set(b.def.id, b)
  }

  /** Remove a native block (workspace pack replacement on re-approval). */
  removeNativeBlock(id: string): void {
    this.native.delete(id)
  }

  /** Add pack workflows after construction (workspace pack hot-load). */
  addPackWorkflows(wfs: BlockDefinition[]): void {
    for (const wf of wfs) this._loadPackDef(wf, 'workflow')
  }

  /** Remove a pack workflow (workspace pack replacement on re-approval). */
  removePackWorkflow(id: string): void {
    this.packDefs.delete(id)
  }

  /** Add pack command blocks after construction (workspace pack hot-load). */
  addPackCommands(cmds: BlockDefinition[]): void {
    for (const cmd of cmds) this._loadPackDef(cmd, 'command')
  }

  /** Remove a pack command block (workspace pack replacement on re-approval). */
  removePackCommand(id: string): void {
    this.packDefs.delete(id)
  }

  /** True if id is a built-in pack def (workflow or command) — reserved; a
   *  workspace native block must not shadow it, and it cannot be overwritten
   *  via registerBlock. */
  isPackWorkflow(id: string): boolean {
    return this.packDefs.has(id)
  }

  /** Map of native block id -> handler, for the engine. */
  nativeHandlers(): Map<string, NativeRunFn> {
    const m = new Map<string, NativeRunFn>()
    for (const [id, b] of this.native) m.set(id, b.run)
    return m
  }
}
