import type { BlockDefinition } from '../core/types'
import type { Registry } from '../registry/file-registry'
import type { NativeBlock, NativeRunFn } from './types'

/**
 * Read/run view over built-in pack blocks layered on top of the user's file
 * registry. Pack (native) blocks take precedence and are never written to disk;
 * writes (registerBlock/deleteBlock) always go to the file registry. The engine
 * uses `nativeHandlers()` to execute native blocks.
 *
 * Pack workflows occupy a slot between native blocks and the file registry:
 *   native block id → pack workflow id → file registry id
 * A native block id always wins a collision with a pack workflow id (error at
 * load time so pack authors catch it early). Pack workflow ids are stamped
 * `approval: 'approved'` at load time — trusted by origin, same rationale as
 * native blocks.
 */
export class CompositeRegistry implements Registry {
  private native = new Map<string, NativeBlock>()
  /**
   * Pack-shipped workflow definitions, stamped approved at load time.
   * Resolution order: native > packWorkflow > file.
   */
  private packWorkflows = new Map<string, BlockDefinition>()
  /** Legacy id → current id (e.g. the pre-rename `qa.*` ids). Never removed. */
  private aliases: Map<string, string>

  constructor(
    private file: Registry,
    nativeBlocks: NativeBlock[] = [],
    aliases: Map<string, string> = new Map(),
    packWorkflowDefs: BlockDefinition[] = [],
  ) {
    this.aliases = aliases
    for (const b of nativeBlocks) {
      if (this.native.has(b.def.id)) {
        throw new Error(`Duplicate native block id across packs: ${b.def.id}`)
      }
      this.native.set(b.def.id, b)
    }
    for (const wf of packWorkflowDefs) {
      this._loadPackWorkflow(wf)
    }
  }

  /** Stamp and register a single pack workflow definition. Internal helper. */
  private _loadPackWorkflow(wf: BlockDefinition): void {
    if (this.native.has(wf.id)) {
      throw new Error(
        `Pack workflow id "${wf.id}" collides with a native block id — rename the workflow`,
      )
    }
    if (this.packWorkflows.has(wf.id)) {
      throw new Error(`Duplicate pack workflow id: ${wf.id}`)
    }
    // Stamp approval unconditionally — trusted by origin (pack-shipped).
    this.packWorkflows.set(wf.id, { ...wf, approval: 'approved' })
  }

  getBlock(id: string, version?: string): BlockDefinition | undefined {
    const n = this.native.get(id) ?? this.native.get(this.aliases.get(id) ?? '')
    // Honor a version pin: a pin that doesn't match the native block falls
    // through to the file registry (and ultimately resolves to undefined),
    // matching FileRegistry semantics so bad pins are rejected at validation.
    if (n && (version === undefined || version === 'latest' || version === n.def.version)) {
      return n.def
    }
    // Pack workflows: same version-pin semantics.
    const pw = this.packWorkflows.get(id)
    if (pw && (version === undefined || version === 'latest' || version === pw.version)) {
      // Return a copy: a caller that mutates the result (e.g. setApproval/deprecate
      // before registerBlock rejects the write) must not be able to corrupt the
      // stored built-in workflow, which would otherwise persist until restart.
      return { ...pw }
    }
    return this.file.getBlock(id, version)
  }

  listBlocks(): BlockDefinition[] {
    const out = [...this.native.values()].map((b) => b.def)
    const nativeIds = new Set(this.native.keys())
    // Pack workflows listed after native blocks; shadowed by native ids (already guarded above).
    for (const pw of this.packWorkflows.values()) {
      if (!nativeIds.has(pw.id)) out.push(pw)
    }
    const reservedIds = new Set([...nativeIds, ...this.packWorkflows.keys()])
    for (const b of this.file.listBlocks()) {
      if (!reservedIds.has(b.id)) out.push(b)
    }
    return out
  }

  registerBlock(block: BlockDefinition): void {
    if (this.native.has(block.id)) {
      throw new Error(`Cannot overwrite built-in pack block: ${block.id}`)
    }
    if (this.packWorkflows.has(block.id)) {
      throw new Error(`Cannot overwrite built-in pack workflow: ${block.id}`)
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
    if (this.packWorkflows.has(id)) {
      throw new Error(`Cannot delete built-in pack workflow: ${id}`)
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
    for (const wf of wfs) this._loadPackWorkflow(wf)
  }

  /** Remove a pack workflow (workspace pack replacement on re-approval). */
  removePackWorkflow(id: string): void {
    this.packWorkflows.delete(id)
  }

  /** True if id is a built-in pack workflow — reserved; a workspace native block
   *  must not shadow it, and it cannot be overwritten via registerBlock. */
  isPackWorkflow(id: string): boolean {
    return this.packWorkflows.has(id)
  }

  /** Map of native block id -> handler, for the engine. */
  nativeHandlers(): Map<string, NativeRunFn> {
    const m = new Map<string, NativeRunFn>()
    for (const [id, b] of this.native) m.set(id, b.run)
    return m
  }
}
