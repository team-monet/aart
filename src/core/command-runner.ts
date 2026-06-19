import { spawn } from 'node:child_process'
import path from 'node:path'
import { resolveValue, type ResolveScope } from './resolver'
import type { ExecutionContext } from './context'
import type { Execution } from './types'

/**
 * Run a `command` block: a host command whose binary and argv template were
 * approved as part of the definition. Guardrails:
 *  - spawned WITHOUT a shell — an input containing `; rm -rf` is a literal
 *    argument, never a second command;
 *  - inputs interpolate into individual argv slots; the binary and cwd are
 *    fixed strings (validation rejects `{{` in them);
 *  - cwd is confined to the workspace;
 *  - the child gets a minimal env plus the declared `env` template — secrets
 *    flow through {{secrets.X}} there and are redacted from the report.
 * Every execution is captured in the run record (stdout/stderr/exitCode), so
 * frequent CLI operations become auditable history instead of vanished shell.
 */

type CommandExecution = Extract<Execution, { type: 'command' }>

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 200_000

export interface CommandResult {
  output: Record<string, unknown>
  durationMs: number
}

function interpolate(template: string, scope: ResolveScope, what: string): string {
  const v = resolveValue(template, scope)
  if (v === undefined || v === null) throw new Error(`${what} resolved to ${String(v)}: ${template}`)
  return typeof v === 'string' ? v : JSON.stringify(v)
}

// Matches a whole-string single secret reference: "{{secrets.foo_bar}}" (with
// optional inner whitespace). Used to identify the "unset optional secret"
// pattern where we intentionally omit the env var rather than throwing.
const SINGLE_SECRET_REF_RE = /^\{\{\s*secrets\.[\w]+\s*\}\}$/

/**
 * Like interpolate() but selectively returns undefined for unset optional
 * secrets. Used for env-var values only.
 *
 * Omit-vs-throw logic:
 *   - If the trimmed template is a SINGLE whole-string secret reference
 *     (e.g. `{{secrets.gh_token}}`) AND the resolver throws "Unresolved"
 *     (meaning the secret is not set) → return undefined (omit the entry).
 *     This is the intended optional-secret case: the child falls back to
 *     ambient auth or a different mechanism.
 *   - For ANY other unresolved env template — a typo'd `{{inputs.token}}`,
 *     a composite `{{secrets.x}}{{y}}`, a misspelled resolver root — THROW
 *     so structural bugs surface rather than being silently swallowed.
 *
 * Argv-slot interpolation uses the strict `interpolate()` above.
 */
function interpolateEnvValue(template: string, scope: ResolveScope): string | undefined {
  try {
    const v = resolveValue(template, scope)
    if (v === undefined || v === null) return undefined
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Only silently omit when: the template is a lone secrets.* reference
    // AND the resolver says it's unresolved (the secret is simply not set).
    if (msg.startsWith('Unresolved') && SINGLE_SECRET_REF_RE.test(template.trim())) {
      return undefined
    }
    // Everything else — typo'd inputs.*, composite templates, wrong root — throws.
    throw err
  }
}

function clamp(s: string): { text: string; truncated: boolean } {
  return s.length > MAX_OUTPUT_CHARS
    ? { text: s.slice(0, MAX_OUTPUT_CHARS), truncated: true }
    : { text: s, truncated: false }
}

export async function runCommandBlock(
  exec: CommandExecution,
  inputs: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  ctx: ExecutionContext,
): Promise<CommandResult> {
  const start = Date.now()
  const scope: ResolveScope = {
    inputs,
    params,
    ctx: { runId: ctx.runId, vars: ctx.vars },
    secrets: ctx.secrets,
    steps: {},
  }
  const args = exec.args.map((a, i) => interpolate(a, scope, `args[${i}]`))

  // cwd is a fixed workspace-relative string, confined like the file blocks.
  const root = path.resolve(ctx.workspace)
  const cwd = path.resolve(root, exec.cwd ?? '.')
  if (cwd !== root && !cwd.startsWith(root + path.sep)) {
    throw new Error(`cwd escapes the workspace: ${exec.cwd}`)
  }

  // Build the child env in two phases:
  // 1. Whitelist ambient vars (standard PATH/HOME/etc. plus well-known CLI auth vars).
  //    GH_TOKEN / GITHUB_TOKEN let `gh` use ambient auth when no gh_token secret is
  //    set; KUBECONFIG lets `kubectl` find the cluster config from the host env.
  // 2. Apply block-declared `env` overrides (resolved secrets/inputs) on top — these
  //    take precedence so an explicit {{secrets.gh_token}} wins over ambient GH_TOKEN.
  const env: Record<string, string> = {}
  for (const k of [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'SYSTEMROOT', 'USERPROFILE',
    'GH_TOKEN', 'GITHUB_TOKEN', 'KUBECONFIG',
  ]) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  for (const [k, v] of Object.entries(exec.env ?? {})) {
    // Env-var values are optional: an unset secret (undefined) means omit the
    // override so the ambient value (set in phase 1 above) flows through.
    // Argv-slot interpolation (above) remains strict.
    const resolved = interpolateEnvValue(v, scope)
    if (resolved !== undefined) env[k] = resolved
  }

  const timeoutMs = exec.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(exec.command, args, { cwd, env, shell: false })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`failed to start "${exec.command}": ${err.message}`))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        return reject(new Error(`command "${exec.command}" timed out after ${timeoutMs}ms`))
      }
      const exitCode = code ?? -1
      if (exitCode !== 0 && exec.failOnError !== false) {
        const tail = (stderr || stdout).slice(-800)
        return reject(
          new Error(`"${exec.command}" exited ${exitCode}${tail ? `:\n${tail}` : ''}`),
        )
      }
      const out = clamp(stdout)
      const errOut = clamp(stderr)
      resolve({
        output: {
          stdout: out.text,
          stderr: errOut.text,
          exitCode,
          ok: exitCode === 0,
          truncated: out.truncated || errOut.truncated,
        },
        durationMs: Date.now() - start,
      })
    })

    child.stdin.end()
  })
}
