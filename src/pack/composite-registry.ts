import type { BlockDefinition } from '../core/types'
import type { Registry } from '../registry/file-registry'
import type { NativeBlock, NativeRunFn } from './types'

/**
 * Read/run view over built-in pack blocks layered on top of the user's file
 * registry. Pack (native) blocks take precedence and are never written to disk;
 * writes (registerBlock/deleteBlock) always go to the file registry. The engine
 * uses `nativeHandlers()` to execute native blocks.
 */
export class CompositeRegistry implements Registry {
  private native = new Map<string, NativeBlock>()

  constructor(
    private file: Registry,
    nativeBlocks: NativeBlock[] = [],
  ) {
    for (const b of nativeBlocks) {
      if (this.native.has(b.def.id)) {
        throw new Error(`Duplicate native block id across packs: ${b.def.id}`)
      }
      this.native.set(b.def.id, b)
    }
  }

  getBlock(id: string, version?: string): BlockDefinition | undefined {
    const n = this.native.get(id)
    // Honor a version pin: a pin that doesn't match the native block falls
    // through to the file registry (and ultimately resolves to undefined),
    // matching FileRegistry semantics so bad pins are rejected at validation.
    if (n && (version === undefined || version === 'latest' || version === n.def.version)) {
      return n.def
    }
    return this.file.getBlock(id, version)
  }

  listBlocks(): BlockDefinition[] {
    const out = [...this.native.values()].map((b) => b.def)
    const nativeIds = new Set(this.native.keys())
    for (const b of this.file.listBlocks()) {
      if (!nativeIds.has(b.id)) out.push(b)
    }
    return out
  }

  registerBlock(block: BlockDefinition): void {
    if (this.native.has(block.id)) {
      throw new Error(`Cannot overwrite built-in pack block: ${block.id}`)
    }
    this.file.registerBlock(block)
  }

  deleteBlock(id: string): void {
    if (this.native.has(id)) {
      throw new Error(`Cannot delete built-in pack block: ${id}`)
    }
    this.file.deleteBlock(id)
  }

  /** Map of native block id -> handler, for the engine. */
  nativeHandlers(): Map<string, NativeRunFn> {
    const m = new Map<string, NativeRunFn>()
    for (const [id, b] of this.native) m.set(id, b.run)
    return m
  }
}
