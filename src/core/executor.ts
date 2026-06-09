import crypto from 'node:crypto'
import ivm from 'isolated-vm'
import type { ExecutionContext } from './context'

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

// Cross-isolate V8 compile cache, keyed by the wrapped source hash. `cachedData`
// is an ExternalCopy that lives in the host and survives isolate disposal, so a
// given block's code is parsed once even though every run gets a fresh isolate.
const compileCache = new Map<string, ivm.ExternalCopy<ArrayBuffer>>()

function wrap(code: string): string {
  // User code may reference `inputs`, `ctx`, `console`, and `return` a value.
  return `(async function () {
  const inputs = JSON.parse(__inputsJson);
  const ctx = JSON.parse(__ctxJson);
  const console = {
    log: (...a) => __log(a.map(String).join(' ')),
    info: (...a) => __log(a.map(String).join(' ')),
    warn: (...a) => __log(a.map(String).join(' ')),
    error: (...a) => __log(a.map(String).join(' ')),
  };
  const __run = async () => { ${code}
  };
  const out = await __run();
  return JSON.stringify(out === undefined ? null : out);
})()`
}

/**
 * Run a `node` block's code in a real V8 isolate (isolated-vm). The isolate has
 * its own heap with NO references to the host: no `process`, `require`, `fs`,
 * network, timers, or env — so the constructor-chain escape that defeats
 * `node:vm` is impossible. Enforces a memory limit and a hard timeout (a runaway
 * loop is actually terminated, not just abandoned).
 *
 * A fresh isolate per run gives full isolation between blocks (no shared heap, so
 * no cross-block prototype pollution); the V8 compile cache keeps repeated runs
 * of the same code cheap.
 *
 * Constraints by design: a sandboxed block is pure compute. It receives `inputs`
 * and a minimal `ctx` ({runId, vars}) as COPIES and returns a JSON-serializable
 * object. It does NOT receive capabilities (e.g. a live browser page) or secrets
 * — those cannot cross an isolate boundary, and capability work belongs in
 * trusted native pack blocks.
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
  const isolate = new ivm.Isolate({ memoryLimit: memoryMb })
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const context = await isolate.createContext()
    const jail = context.global
    await jail.set('__inputsJson', JSON.stringify(inputs ?? {}))
    await jail.set('__ctxJson', JSON.stringify({ runId: ctx.runId, vars: ctx.vars }))
    await jail.set(
      '__log',
      new ivm.Callback((s: string) => {
        logs.push(s)
      }),
    )

    const wrapped = wrap(code)
    const key = crypto.createHash('sha256').update(wrapped).digest('hex')
    const cached = compileCache.get(key)
    const script = await isolate.compileScript(
      wrapped,
      cached ? { cachedData: cached } : { produceCachedData: true },
    )
    const produced = (script as unknown as { cachedData?: ivm.ExternalCopy<ArrayBuffer> }).cachedData
    if (!cached && produced) compileCache.set(key, produced)

    // The isolate `timeout` cancels sync CPU loops; a host wall-clock race also
    // covers an async block that never settles (no timers exist in-isolate).
    const hostTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Block timed out after ${timeoutMs}ms`)),
        timeoutMs + 250,
      )
    })
    const resultStr = (await Promise.race([
      script.run(context, { timeout: timeoutMs, promise: true }),
      hostTimeout,
    ])) as string

    const parsed: unknown = JSON.parse(resultStr)
    const output =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : { value: parsed }
    return { output, logs, durationMs: Date.now() - start }
  } finally {
    if (timer) clearTimeout(timer)
    if (!isolate.isDisposed) isolate.dispose()
  }
}

/**
 * Static gate: compile a `node` block's code (without running it) to reject
 * syntactically invalid code at registration time. Returns an error message, or
 * null if the code parses. The sandbox is the security boundary; this is the
 * cheap correctness gate on top of it.
 */
export function checkNodeSyntax(code: string): string | null {
  const isolate = new ivm.Isolate({ memoryLimit: 8 })
  try {
    isolate.compileScriptSync(wrap(code))
    return null
  } catch (err) {
    return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
  } finally {
    isolate.dispose()
  }
}
