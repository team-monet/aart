import vm from 'node:vm'
import type { ExecutionContext } from './context'

export interface ExecResult {
  output: Record<string, unknown>
  logs: string[]
  durationMs: number
}

export interface ExecOptions {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * ⚠️  TEMPORARY in-process executor for `node` blocks.
 *
 * `node:vm` is NOT a security boundary — it does not stop fs / network /
 * process access from inside the evaluated code. It exists here only so the
 * runtime is runnable end-to-end during early development, and it is strictly
 * better than the legacy approach (which ran untrusted code via
 * `spawn('node')` directly in the server process with a runtime `npm install`).
 *
 * Before enabling L3 (AI-generated block CODE), replace this with a real
 * sandbox tier — `isolated-vm`, a restricted runtime, or Docker. The chosen
 * tier is the critical fork; see docs/IMPLEMENTATION_PLAN.md → "Decisions".
 *
 * The block contract: the code body may `return <object>` and may reference the
 * globals `inputs` and `ctx`. Output is the returned object (non-objects are
 * wrapped as `{ value }`).
 */
export async function runNodeBlock(
  code: string,
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const logs: string[] = []
  const record = (...args: unknown[]) => logs.push(args.map(String).join(' '))

  const sandbox: Record<string, unknown> = {
    inputs,
    ctx: {
      runId: ctx.runId,
      vars: ctx.vars,
      // NB: the raw secrets map is intentionally NOT exposed to node-block code.
      // A block receives any secret it needs via resolved {{secrets.X}} inputs.
      capabilities: ctx.capabilities,
    },
    console: { log: record, error: record, warn: record, info: record },
    Math,
    JSON,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
  }

  const context = vm.createContext(sandbox)
  const wrapped = `(async () => {\n${code}\n})()`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const start = Date.now()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Block timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })

  try {
    // The vm `timeout` bounds synchronous code; Promise.race bounds async code.
    const raw = await Promise.race([
      vm.runInContext(wrapped, context, { timeout: timeoutMs }),
      timeout,
    ])
    const output =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : { value: raw }
    return { output, logs, durationMs: Date.now() - start }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
