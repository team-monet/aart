import type { ExecutionContext } from './context'

// isolated-vm is an OPTIONAL dependency (a native addon). It is only needed to
// run/validate `node` blocks — the core pack's native browser/api/assert blocks
// never touch it. Load it lazily so installing aart never fails on a platform
// without a prebuilt binary, and so QA-only usage works without it.
type Ivm = typeof import('isolated-vm')
let _ivm: Ivm | undefined
function ivm(): Ivm {
  if (_ivm) return _ivm
  try {
    _ivm = require('isolated-vm') as Ivm
  } catch {
    throw new Error(
      'Running `node` blocks requires the optional "isolated-vm" package. ' +
        'Install it with:  npm i isolated-vm   (native browser/api/assert blocks do not need it).',
    )
  }
  return _ivm
}

export interface ExecResult {
  output: Record<string, unknown>
  logs: string[]
  durationMs: number
}

export interface ExecOptions {
  timeoutMs?: number
  memoryMb?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MEMORY_MB = 128
const MAX_CONCURRENT = 8

/**
 * Constant trusted wrapper. The user's code is NOT spliced into this source —
 * it is passed in as the `__userCode` global string and turned into an async
 * function via the Function constructor INSIDE the isolate. That makes the
 * wrapper structurally un-breakable: a stray `}` in user code can no longer
 * restructure the wrapper or hijack the return value (it just makes the
 * AsyncFunction throw a SyntaxError). The wrapper always returns a JSON string.
 */
const WRAPPER = `(async function () {
  const inputs = JSON.parse(__inputsJson);
  const ctx = JSON.parse(__ctxJson);
  const code = __userCode;
  delete globalThis.__inputsJson;
  delete globalThis.__ctxJson;
  delete globalThis.__userCode;
  const console = {
    log: (...a) => __log(a.map(String).join(' ')),
    info: (...a) => __log(a.map(String).join(' ')),
    warn: (...a) => __log(a.map(String).join(' ')),
    error: (...a) => __log(a.map(String).join(' ')),
  };
  const AsyncFunction = (async () => {}).constructor;
  const run = new AsyncFunction('inputs', 'ctx', 'console', code);
  const out = await run(inputs, ctx, console);
  return JSON.stringify(out === undefined ? null : out);
})()`

// The wrapper is constant, so its V8 compile cache is a single off-heap handle
// (no per-block growth). It survives isolate disposal and is reused every run.
let wrapperCache: import('isolated-vm').ExternalCopy<ArrayBuffer> | undefined

// Bound the number of simultaneously-live isolates (each is a worker thread that
// reserves its memory ceiling) so parallel runs can't exhaust host resources.
let active = 0
const waiters: Array<() => void> = []
async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r))
  active++
}
function release(): void {
  active--
  waiters.shift()?.()
}

/**
 * Run a `node` block's code in a real V8 isolate (isolated-vm). The isolate has
 * its own heap with NO references to the host: no `process`, `require`, `fs`,
 * network, timers, or env — so the constructor-chain escape that defeats
 * `node:vm` is impossible. Enforces a memory limit and a HARD timeout (a runaway
 * loop is terminated, not just abandoned). A fresh isolate per run gives full
 * isolation between blocks (no shared heap → no cross-block prototype pollution).
 *
 * Constraints by design: a sandboxed block is pure compute. It receives `inputs`
 * and a minimal `ctx` ({runId, vars}) as COPIES and must return a JSON-
 * serializable object. It gets NO capabilities or secrets — those cannot cross
 * an isolate boundary, and capability work belongs in trusted native pack blocks.
 */
export async function runNodeBlock(
  code: string,
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const memoryMb = opts.memoryMb ?? DEFAULT_MEMORY_MB
  const logs: string[] = []
  const start = Date.now()

  const m = ivm()
  await acquire()
  const isolate = new m.Isolate({ memoryLimit: memoryMb })
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const context = await isolate.createContext()
    const jail = context.global
    await jail.set('__userCode', code)
    await jail.set('__inputsJson', JSON.stringify(inputs ?? {}))
    await jail.set('__ctxJson', JSON.stringify({ runId: ctx.runId, vars: ctx.vars }))
    await jail.set('__log', new m.Callback((s: string) => void logs.push(s)))

    const script = await isolate.compileScript(
      WRAPPER,
      wrapperCache ? { cachedData: wrapperCache } : { produceCachedData: true },
    )
    const produced = (script as unknown as { cachedData?: import('isolated-vm').ExternalCopy<ArrayBuffer> }).cachedData
    if (!wrapperCache && produced) wrapperCache = produced

    // The isolate `timeout` cancels sync CPU loops; a host wall-clock race also
    // covers an async block that never settles (no timers exist in-isolate).
    const hostTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Block timed out after ${timeoutMs}ms`)),
        timeoutMs + 250,
      )
    })
    const raw: unknown = await Promise.race([
      script.run(context, { timeout: timeoutMs, promise: true }),
      hostTimeout,
    ])

    // The wrapper always returns a JSON string; anything else means the block
    // produced a non-serializable value — fail clearly rather than opaquely.
    if (typeof raw !== 'string') {
      throw new Error('block did not return a JSON-serializable value')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('block did not return a JSON-serializable value')
    }
    const output =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : { value: parsed }
    return { output, logs, durationMs: Date.now() - start }
  } finally {
    if (timer) clearTimeout(timer)
    if (!isolate.isDisposed) isolate.dispose()
    release()
  }
}

/**
 * Static gate: compile a `node` block's code as a parenthesized async function
 * EXPRESSION (without running it). This rejects both syntax errors AND a
 * structural break-out (a stray `}` that would otherwise restructure the run
 * wrapper) at registration time. Returns an error message, or null if valid.
 */
export function checkNodeSyntax(code: string): string | null {
  const isolate = new (ivm().Isolate)({ memoryLimit: 8 })
  try {
    isolate.compileScriptSync(`(async function (inputs, ctx, console) {\n${code}\n})`)
    return null
  } catch (err) {
    return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
  } finally {
    isolate.dispose()
  }
}
