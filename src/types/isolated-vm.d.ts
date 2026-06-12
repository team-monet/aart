/**
 * Build-time type stub for isolated-vm ^6.1.2.
 *
 * This stub is intentionally minimal — it declares only the API surface that
 * executor.ts uses so that `tsc` resolves the module on every platform,
 * including Node 20 where `npm ci` skips the optional isolated-vm install
 * (its engines field requires node>=22).
 *
 * IMPORTANT: this stub SHADOWS the real isolated-vm .d.ts on Node 22 as well,
 * so tsc always type-checks executor.ts against this file, not the upstream
 * types. Drift from the real isolated-vm API is caught only at RUNTIME by the
 * Node-22 test suite (executor tests run the real addon). Keep the stub in sync
 * with the real API when upgrading isolated-vm.
 *
 * The real module is require()'d lazily at runtime inside executor.ts — it is
 * never imported at module load time, so Node-20 consumers (who lack the addon)
 * are unaffected as long as they don't execute `node` blocks.
 *
 * Mirrors: isolated-vm ^6.1.2
 */
declare module 'isolated-vm' {
  /** Options accepted by the Isolate constructor. */
  export interface IsolateOptions {
    memoryLimit?: number
  }

  /** Options accepted by compileScript / compileScriptSync. */
  export interface CompileScriptOptions {
    /** Supply a previously-produced V8 compile cache to skip re-parsing. */
    cachedData?: ExternalCopy<ArrayBuffer>
    /** Ask V8 to produce a compile cache for future reuse. */
    produceCachedData?: boolean
  }

  /** Options accepted by Script.run. */
  export interface RunOptions {
    /** Wall-clock timeout in milliseconds for sync loops (host-enforced). */
    timeout?: number
    /** If true, the result is unwrapped from a Promise. */
    promise?: boolean
  }

  /**
   * A handle to a value in an isolate's heap. The type parameter is the type
   * of data the reference points to inside the isolate.
   */
  export class Reference<T = unknown> {
    set(key: string, value: unknown): Promise<void>
  }

  /**
   * A value that has been copied out of an isolate's heap and can be passed
   * across isolate boundaries. Used here to carry the V8 compile cache for
   * the wrapper script across isolate lifetimes.
   */
  export class ExternalCopy<T> {
    constructor(value: T)
  }

  /** A compiled script that can be run inside a Context. */
  export class Script {
    run(context: Context, opts?: RunOptions): Promise<unknown>
    /** Populated when produceCachedData was set during compilation. */
    cachedData?: ExternalCopy<ArrayBuffer>
  }

  /**
   * An execution context inside an Isolate — analogous to a browser tab.
   * Each context has its own global object.
   */
  export class Context {
    readonly global: Reference
  }

  /**
   * A host-side function that can be called from inside the isolate via a
   * Reference. The isolate cannot hold a direct JS closure — Callback
   * serialises the call back to the host thread.
   *
   * The constructor is generic so callers can pass narrowly-typed callbacks
   * (e.g. `(s: string) => void`) without a type error.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class Callback<T extends (...args: any[]) => any = (...args: unknown[]) => unknown> {
    constructor(fn: T)
  }

  /**
   * A V8 isolate — an independent heap with its own JS context, no shared
   * references to the host. Creating one spawns a worker thread.
   */
  export class Isolate {
    constructor(options?: IsolateOptions)
    /** True once dispose() has been called. */
    readonly isDisposed: boolean
    createContext(): Promise<Context>
    compileScript(code: string, info?: CompileScriptOptions): Promise<Script>
    compileScriptSync(code: string): Script
    dispose(): void
  }
}
