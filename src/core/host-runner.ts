import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ExecutionContext } from './context'
import type { ExecOptions, ExecResult } from './executor'

/**
 * Host tier for `node` blocks that declare `dependencies`. Unlike the isolate
 * tier (pure compute, no I/O), a dependency-bearing block runs in a REAL Node.js
 * subprocess with its declared npm packages installed — it can do anything the
 * user can. The security boundary is governance, not a sandbox: these blocks
 * stay `draft` until the user approves them, and the approval summary states
 * the dependency list and the unsandboxed nature loudly.
 *
 * Contract is identical to the isolate tier — the code body receives
 * (inputs, ctx {runId, vars}, console) and returns a JSON object — plus a
 * `require` that resolves the declared dependencies. `dependencies` entries:
 *   - "name" / "name@range" / "@scope/name@range" — npm-installed into a
 *     content-addressed dir under `.aa/deps/<hash>` shared by all blocks that
 *     declare the same set (installed once, reused).
 *   - "node:fs", "node:crypto", … — grants the host tier without installing
 *     anything (Node built-ins are already available to `require`).
 */

const DEFAULT_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 300_000

interface ParsedDep {
  /** npm package name, or undefined for a `node:` built-in entry. */
  name?: string
  range?: string
}

// npm package name (optionally scoped), optionally followed by @range. The
// range may not contain `:` or `/` — that keeps installs registry-only
// (no file:/git:/http:/github-shorthand sources smuggled in as a "version").
const NAME_RE = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/
const RANGE_RE = /^[A-Za-z0-9 .\-^~<>=*|&+]+$/
const BUILTIN_RE = /^node:[a-z0-9_]+(\/[a-z0-9_]+)?$/

function parseDep(entry: string): ParsedDep | string {
  if (BUILTIN_RE.test(entry)) return {}
  // Split name from range at the first `@` past position 0 (scoped names keep
  // their leading `@scope/` intact).
  const at = entry.indexOf('@', entry.startsWith('@') ? entry.indexOf('/') : 1)
  const name = at === -1 ? entry : entry.slice(0, at)
  const range = at === -1 ? undefined : entry.slice(at + 1)
  if (!NAME_RE.test(name)) {
    return `invalid dependency "${entry}" — expected "name", "name@range", "@scope/name@range", or "node:builtin"`
  }
  if (range !== undefined && !RANGE_RE.test(range)) {
    return `invalid dependency range in "${entry}" — registry versions/ranges only (no file:, git:, or URL sources)`
  }
  return { name, range }
}

/** Validate a `dependencies` list. Returns error messages (empty = valid). */
export function checkDependencies(deps: string[]): string[] {
  const errors: string[] = []
  for (const entry of deps) {
    const parsed = parseDep(entry)
    if (typeof parsed === 'string') errors.push(parsed)
  }
  return errors
}

/**
 * Static gate for host-tier code: compile (never run) the body as an async
 * function with the host signature. Pure parse — works without isolated-vm.
 */
export function checkHostNodeSyntax(code: string): string | null {
  try {
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => unknown
    new AsyncFunction('inputs', 'ctx', 'console', 'require', code)
    return null
  } catch (err) {
    return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
  }
}

/** npm deps (name → range) from a mixed list; `node:` entries install nothing. */
function installable(deps: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of deps) {
    if (BUILTIN_RE.test(entry)) continue
    const parsed = parseDep(entry)
    if (typeof parsed === 'string') throw new Error(parsed)
    if (parsed.name) out[parsed.name] = parsed.range ?? 'latest'
  }
  return out
}

// One install per dependency set per process — parallel runs of blocks sharing
// a set await the same install instead of racing npm in the same directory.
const installs = new Map<string, Promise<string>>()

/**
 * Ensure the content-addressed deps dir for this dependency set exists and is
 * installed. Returns the dir. A `.aart-installed` marker makes repeat runs free.
 */
async function ensureDeps(workspace: string, deps: string[]): Promise<string> {
  const pkgs = installable(deps)
  const key = createHash('sha256').update(JSON.stringify(pkgs)).digest('hex').slice(0, 16)
  const dir = path.join(workspace, '.aa', 'deps', key)
  const pending = installs.get(dir)
  if (pending) return pending

  const job = (async () => {
    const marker = path.join(dir, '.aart-installed')
    if (fs.existsSync(marker)) return dir
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'aart-deps', private: true, dependencies: pkgs }, null, 2),
    )
    if (Object.keys(pkgs).length) await npmInstall(dir)
    fs.writeFileSync(marker, new Date().toISOString())
    return dir
  })()
  installs.set(dir, job)
  try {
    return await job
  } catch (err) {
    installs.delete(dir) // a failed install must not poison later attempts
    throw err
  }
}

/** Run `npm install` in `dir`. npm gets the full env (registry/proxy config). */
function npmInstall(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (out += c.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`npm install timed out after ${INSTALL_TIMEOUT_MS}ms`))
    }, INSTALL_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`npm install failed to start: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`npm install failed (exit ${code}):\n${out.slice(-1500)}`))
    })
  })
}

/**
 * The child process source. Constant content, written into the deps dir and
 * spawned with `node`. Protocol: the payload arrives as JSON on stdin; the
 * result leaves as JSON on fd 3 — NOT stdout — so user code printing to
 * stdout/stderr can never corrupt the result channel (those streams are
 * captured as logs instead). `require` resolves from the deps dir.
 */
const RUNNER_SOURCE = `'use strict'
const fsMod = require('node:fs')
const pathMod = require('node:path')
const { createRequire } = require('node:module')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', async () => {
  const logs = []
  const reply = (obj) => { try { fsMod.writeSync(3, JSON.stringify(obj)) } catch {} }
  let payload
  try {
    payload = JSON.parse(input)
  } catch (err) {
    reply({ ok: false, error: 'bad payload: ' + String(err && err.message || err), logs })
    process.exit(0)
  }
  const requireFromDeps = createRequire(pathMod.join(payload.depsDir, 'package.json'))
  const consoleShim = {}
  for (const level of ['log', 'info', 'warn', 'error']) {
    consoleShim[level] = (...a) => logs.push(a.map(String).join(' '))
  }
  try {
    const AsyncFunction = (async () => {}).constructor
    const run = new AsyncFunction('inputs', 'ctx', 'console', 'require', payload.code)
    const out = await run(payload.inputs, payload.ctx, consoleShim, requireFromDeps)
    const json = JSON.stringify(out === undefined ? null : out)
    if (typeof json !== 'string') {
      reply({ ok: false, error: 'block did not return a JSON-serializable value', logs })
    } else {
      reply({ ok: true, resultJson: json, logs })
    }
  } catch (err) {
    const msg = err && err.stack ? String(err.stack).split('\\n').slice(0, 4).join('\\n') : String(err)
    reply({ ok: false, error: msg, logs })
  }
  process.exit(0)
})
`

interface RunnerReply {
  ok: boolean
  resultJson?: string
  error?: string
  logs?: string[]
}

/**
 * Run a dependency-bearing `node` block in a real Node subprocess. Same result
 * contract as the isolate tier's `runNodeBlock`. The child gets a minimal env
 * (PATH/HOME/TMPDIR/LANG/TZ) — secrets reach blocks through wired inputs
 * (`{{secrets.X}}`), never ambient env vars.
 */
export async function runHostNodeBlock(
  code: string,
  dependencies: string[],
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const start = Date.now()
  const dir = await ensureDeps(ctx.workspace, dependencies)
  const runner = path.join(dir, '.aart-runner.cjs')
  fs.writeFileSync(runner, RUNNER_SOURCE)

  const payload = JSON.stringify({
    code,
    inputs: inputs ?? {},
    ctx: { runId: ctx.runId, vars: ctx.vars },
    depsDir: dir,
  })

  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'SYSTEMROOT', 'USERPROFILE']) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })

    let replyRaw = ''
    let stdio = ''
    let timedOut = false
    child.stdio[3]?.on('data', (c: Buffer) => (replyRaw += c.toString()))
    child.stdout?.on('data', (c: Buffer) => (stdio += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (stdio += c.toString()))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`failed to start block process: ${err.message}`))
    })

    child.on('close', () => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`Block timed out after ${timeoutMs}ms`))

      let reply: RunnerReply | undefined
      try {
        reply = JSON.parse(replyRaw) as RunnerReply
      } catch {
        /* fall through to the protocol error below */
      }
      const logs = [
        ...(reply?.logs ?? []),
        ...stdio.split('\n').filter((l) => l.trim() !== ''),
      ]
      if (!reply) {
        return reject(
          new Error(`block process produced no result${stdio ? `:\n${stdio.slice(-800)}` : ''}`),
        )
      }
      if (!reply.ok || reply.resultJson === undefined) {
        return reject(new Error(reply.error ?? 'block failed'))
      }
      const parsed: unknown = JSON.parse(reply.resultJson)
      const output =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : { value: parsed }
      resolve({ output, logs, durationMs: Date.now() - start })
    })

    child.stdin?.end(payload)
  })
}
