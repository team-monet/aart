// aart watch — Wave 2B (AMENDMENTS.md A64): one command that boots the
// whole local stack (server + worker + dashboard) and opens the browser,
// replacing the three-terminal dance TEST-DRIVE.md's own manual walkthrough
// otherwise requires.
//
// RATIFIED DESIGN (John, 2026-07-12/13): supervised SUBPROCESSES, not an
// embedded single-process. Embedding `startServer`/`startWorker`/
// `startDashboard` together inside one process would be the first-ever
// production use of a local/fake-store, all-in-one-process topology this
// codebase has never built or verified — every real composition root today
// (real-server-port.ts, deploy/serve-dashboard.mjs, this package's own
// bin.ts) assumes "one process, one role." Re-executing the CURRENT CLI
// entry point (`process.argv[1]`) for the server/worker children instead
// reuses that exact, already-proven composition root unchanged — this file
// adds a supervisor on top, not a fourth way to start a server.
//
// Every "pure logic" piece below (path/port/env resolution, precondition
// checking, argv assembly, line-prefixing, readiness polling, shutdown
// coordination, the platform browser-opener command) is factored out and
// independently unit-tested (watch.test.ts) — the orchestration function at
// the bottom (`watchCommand`) wires real fs/child_process/fetch/console
// calls around them and is deliberately NOT unit-tested itself: it spawns
// real OS processes and shells out to open a real browser, neither of
// which belongs in this repo's fast/offline/deterministic CI suite. See
// watch.test.ts's own header comment for exactly what is and isn't covered.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HEALTH_PORT, DEFAULT_HTTP_PORT } from "@aart/server";
import type { HandlerResult } from "@aart/mcp";
import { flagString, type Tokenized } from "../args.js";
import type { CliContext } from "../cli-context.js";
import { resolveDeployToken } from "../secrets.js";
import { waitForShutdownSignal, type ProcessCommandOptions } from "./process.js";

/** `@aart/dashboard`'s own `DEFAULT_DASHBOARD_PORT` (packages/dashboard/src/config.ts) is deliberately NOT imported here — `packages/cli` is the ONE package this monorepo publishes to npm (package.json's own description, ADR-18), and `@aart/dashboard` is a private, workspace-only package this codebase has kept OUT of the CLI's dependency graph on purpose (deploy/serve-dashboard.mjs, not packages/cli, is the one place that imports it directly — see that file's own header comment). A literal duplicate of the same value, not a re-export, so a real `aart watch` and a real dashboard launched via `deploy/serve-dashboard.mjs` still agree by default. */
const WATCH_DEFAULT_DASHBOARD_PORT = 4000;

/** Total time `aart watch` waits for all three `/health` endpoints to come up before giving up and refusing to open a browser at all — generous headroom for a cold sqlite migration + dashboard SPA static-file setup on a slow disk, not derived from any external constraint (same "generous headroom for the common case" discipline AMENDMENTS.md A63 FIX 3 used for `DEFAULT_EVENTS_LIMIT`). */
const WATCH_READY_TIMEOUT_MS = 30_000;
const WATCH_READY_POLL_INTERVAL_MS = 250;

/** How long `aart watch` waits after forwarding SIGTERM to a child before escalating to SIGKILL. `aart server`/`aart worker` drain in-flight work on SIGTERM (process.ts's own `waitForShutdownSignal` + `handle.close()`/`handle.stop()` sequence; DEPLOY.md: "drains in-flight steps to their next checkpoint before exiting") — long enough for a checkpoint, not for an entire in-flight step to finish running. */
const WATCH_SHUTDOWN_GRACE_MS = 10_000;

export interface WatchConfig {
  serverPort: number;
  dashboardPort: number;
  /** Fixed at `@aart/server`'s own `DEFAULT_HEALTH_PORT` (8787) — NOT flag-configurable: `aart worker` itself (commands/process.ts's `workerCommand`) reads no `--port`/health-port flag at all today, so a spawned `aart worker` child always listens on this exact default regardless of what `aart watch` is told. */
  workerHealthPort: number;
  store: "fs" | "sqlite";
  root: string;
}

/**
 * Pure config resolution — `--server-port`/`--dashboard-port`/`--store`
 * flags (defaults DEFAULT_HTTP_PORT/WATCH_DEFAULT_DASHBOARD_PORT/"fs"), plus
 * `cli.root` for `--root`/`AART_ROOT`/default (already resolved once by
 * cli.ts's own `resolveCliContext` with flag > env > default precedence —
 * reused here rather than re-derived, same discipline `commands/remote.ts`
 * already established for its own root-only needs). `--store`'s value is
 * already validated to be `"fs" | "sqlite" | undefined` by the time any
 * command runs (cli.ts's `resolveCliContext` throws first otherwise) — the
 * `=== "sqlite"` check below is a defensive default, not new validation.
 */
export function resolveWatchConfig(tokens: Tokenized, cli: Pick<CliContext, "root">): WatchConfig {
  const serverPortFlag = flagString(tokens.flags, "server-port");
  const dashboardPortFlag = flagString(tokens.flags, "dashboard-port");
  const storeFlag = flagString(tokens.flags, "store");
  return {
    serverPort: serverPortFlag ? Number(serverPortFlag) : DEFAULT_HTTP_PORT,
    dashboardPort: dashboardPortFlag ? Number(dashboardPortFlag) : WATCH_DEFAULT_DASHBOARD_PORT,
    workerHealthPort: DEFAULT_HEALTH_PORT,
    store: storeFlag === "sqlite" ? "sqlite" : "fs",
    root: cli.root,
  };
}

export interface WatchPaths {
  cliDistDir: string;
  serveDashboardScript: string;
  dashboardDistDir: string;
}

/**
 * Resolves the two build artifacts `aart watch` needs, relative to the
 * CLI's OWN currently-running entry point (`cliEntryPath` — the real call
 * site passes `process.argv[1]`, e.g. `packages/cli/dist/bin.js` for a real
 * `aart` invocation) rather than `process.cwd()` or this module's own
 * `import.meta.url`. Verified directly, not assumed, before writing this:
 * `deploy/build-dashboard-launcher.mjs`'s own `OUT_FILE` constant bundles
 * `serve-dashboard.mjs` to `packages/cli/dist/serve-dashboard.mjs` —
 * "directly beside packages/cli/node_modules" per that script's own header
 * comment — the EXACT SAME directory `package.json`'s `"bin": {"aart":
 * "./dist/bin.js"}` puts the real entry point in. `packages/dashboard/dist`
 * sits two levels up from there (`packages/cli/dist/../../dashboard/dist`).
 * A pure path computation, no fs access (see `checkWatchPreconditions` for
 * the actual `existsSync` calls) — unit-testable with a synthetic
 * `cliEntryPath` and no real build artifacts on disk.
 */
export function resolveWatchPaths(cliEntryPath: string): WatchPaths {
  const cliDistDir = path.dirname(cliEntryPath);
  return {
    cliDistDir,
    serveDashboardScript: path.join(cliDistDir, "serve-dashboard.mjs"),
    dashboardDistDir: path.resolve(cliDistDir, "..", "..", "dashboard", "dist"),
  };
}

export type PreconditionResult = { ok: true } | { ok: false; error: string };

/**
 * AMENDMENTS.md A47 discipline ("refuse to start rather than serve
 * emptiness") applied here: `aart watch` refuses to spawn anything unless
 * both build artifacts it needs already exist, rather than launching a
 * server+worker pair against a dashboard that will 404, or silently
 * spending several minutes running a surprise build the caller never asked
 * for.
 *
 * Checks `<dashboardDistDir>/index.html` specifically, not merely
 * `dashboardDistDir` itself — verified directly (packages/dashboard/
 * frontend/vite.config.ts's own `build.outDir: '../dist/frontend'`) that
 * the real SPA entry point lands at `packages/dashboard/dist/frontend/
 * index.html`, the exact file `@aart/dashboard`'s own `getFrontendDir()`
 * (packages/dashboard/src/server.ts) looks for first. A bare `dist`
 * directory can exist from `tsc -b` alone (that package's own two-step
 * `build` script runs `build:frontend` before `build:backend`, but a
 * partial/interrupted build, or a stale checkout, could still leave the
 * directory present with no SPA inside it) — checking the real file this
 * command actually depends on is a strictly more accurate proxy than
 * checking the parent directory's mere existence.
 */
export function checkWatchPreconditions(paths: Pick<WatchPaths, "dashboardDistDir" | "serveDashboardScript">): PreconditionResult {
  const frontendEntry = path.join(paths.dashboardDistDir, "index.html");
  const dashboardMissing = !existsSync(frontendEntry);
  const launcherMissing = !existsSync(paths.serveDashboardScript);
  if (!dashboardMissing && !launcherMissing) return { ok: true };

  const missing: string[] = [];
  if (dashboardMissing) missing.push(`the built dashboard frontend (${frontendEntry})`);
  if (launcherMissing) missing.push(`the built dashboard launcher (${paths.serveDashboardScript})`);

  // Remedy verified against DEPLOY.md's own documented sequence for running
  // the dashboard-equivalent without Docker ("build deploy/serve-
  // dashboard.mjs the same way the Dockerfile does: node deploy/build-
  // dashboard-launcher.mjs after pnpm run build") rather than the shorter
  // "just run pnpm run build" a first guess might reach for: root
  // package.json's own `build` script (`tsc -b ... && pnpm --filter
  // @aart/dashboard run build:frontend`) does NOT run `build:dashboard-
  // launcher` — confirmed by reading both scripts, not assumed — so
  // `pnpm run build` alone leaves `packages/cli/dist/serve-dashboard.mjs`
  // missing even after it succeeds. A remedy that only named `pnpm run
  // build` would send a caller in a loop: build succeeds, `aart watch`
  // still refuses to start, for a reason the message never mentioned.
  const remedy = launcherMissing
    ? `Build the workspace first: "pnpm run build" followed by "pnpm run build:dashboard-launcher" (DEPLOY.md's own documented sequence for running the dashboard-equivalent without Docker — the launcher is a separate build step, not produced by "pnpm run build" alone).`
    : `Build the workspace first: "pnpm run build".`;

  return {
    ok: false,
    error: `aart watch: refusing to start — ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing. ${remedy}`,
  };
}

/** Exact argv `aart server` itself parses (commands/process.ts's `serverCommand`) — re-executing the CLI entry with these args reuses that real composition root unchanged. Bound to 127.0.0.1: local `aart watch` is loopback-only by construction (D2a's own breaking-change bind default, AMENDMENTS.md A59, made explicit here rather than relying on the flag being omitted). */
export function buildServerSpawnArgs(config: Pick<WatchConfig, "serverPort" | "store" | "root">): string[] {
  return ["server", "--port", String(config.serverPort), "--host", "127.0.0.1", "--store", config.store, "--root", config.root];
}

/** Exact argv `aart worker` itself parses (commands/process.ts's `workerCommand`) — see buildServerSpawnArgs's own doc comment. No `--port`/health-port flag: `workerCommand` doesn't read one today, so the spawned worker always listens on DEFAULT_HEALTH_PORT (WatchConfig.workerHealthPort). */
export function buildWorkerSpawnArgs(config: Pick<WatchConfig, "store" | "root">): string[] {
  return ["worker", "--root", config.root, "--store", config.store];
}

export interface DashboardEnvInput {
  serverPort: number;
  dashboardPort: number;
  workerHealthPort: number;
  store: "fs" | "sqlite";
  root: string;
  deployToken: string | undefined;
  /** Defaults to `process.env` at the real call site; tests pass a small synthetic object instead of mutating the real process environment. */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Assembles the exact env-var set `deploy/serve-dashboard.mjs` reads —
 * verified by reading that file directly, not guessed, before writing this
 * (its own top-of-file `process.env.AART_*` reads): `AART_SERVER_URL`,
 * `AART_STORE`, `AART_ROOT`, `AART_DASHBOARD_PORT`, `AART_WORKER_URLS`,
 * and — only when configured — `AART_DEPLOY_TOKEN`. Spread over `baseEnv`
 * (defaulting to the real `process.env`) rather than a bare object literal
 * so the dashboard child inherits everything else a normal environment
 * carries (PATH, etc.), the same way every spawn in this file does.
 */
export function buildDashboardEnv(input: DashboardEnvInput): NodeJS.ProcessEnv {
  return {
    ...(input.baseEnv ?? process.env),
    AART_SERVER_URL: `http://127.0.0.1:${input.serverPort}`,
    AART_STORE: input.store,
    AART_ROOT: input.root,
    AART_DASHBOARD_PORT: String(input.dashboardPort),
    AART_WORKER_URLS: `http://127.0.0.1:${input.workerHealthPort}`,
    ...(input.deployToken ? { AART_DEPLOY_TOKEN: input.deployToken } : {}),
  };
}

export interface LinePrefixer {
  /** Feed one stdout/stderr chunk from a child process. */
  write(chunk: Buffer): void;
  /** Flush a trailing partial line with no terminating newline yet — call once, at the child's own "exit" event, so a final unterminated line is never silently dropped. */
  flush(): void;
}

/**
 * Buffers partial lines across chunk boundaries (child stdout/stderr
 * arrives as arbitrary Buffer chunks, not line-aligned) and calls
 * `writeLine` once per complete newline-terminated line, prefixed with
 * `[label] `. `consoleJsonSink` (AMENDMENTS.md A58, wired into every real
 * `aart server`/`aart worker` process since real-server-port.ts) already
 * emits one JSON object per line, so a plain line-prefixer is sufficient —
 * no JSON parsing needed here. Mirrors the chunk-buffering shape already
 * proven in this monorepo's own test infra (packages/server/src/e2e/
 * worker-kill.e2e.test.ts's `spawnScript`) rather than inventing a new one.
 */
export function createLinePrefixer(label: string, writeLine: (line: string) => void): LinePrefixer {
  let buf = "";
  return {
    write(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        writeLine(`[${label}] ${line}`);
      }
    },
    flush(): void {
      if (buf.length > 0) {
        writeLine(`[${label}] ${buf}`);
        buf = "";
      }
    },
  };
}

export type PollResult = { ok: true } | { ok: false; error: string };

export interface PollUntilReadyInput {
  urls: readonly string[];
  timeoutMs: number;
  intervalMs: number;
  /** Defaults to the real global `fetch` (Node 22's built-in — package.json's `engines.node: ">=22"` already requires it). Tests inject a fake so this never makes a real network call. */
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls GET on every url in `urls` until each has returned at least one 2xx
 * response, or `timeoutMs` elapses. Robust to startup ordering — a url
 * that isn't listening yet (connection refused) is treated the same as a
 * non-2xx response: "not ready yet, try again," never a hard failure. Every
 * url is polled every round (not sequentially gated) so a slow first
 * service never delays checking the others.
 */
export async function pollUntilReady(input: PollUntilReadyInput): Promise<PollResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const deadline = Date.now() + input.timeoutMs;
  const pending = new Set(input.urls);
  for (;;) {
    for (const url of [...pending]) {
      try {
        const res = await fetchFn(url);
        if (res.ok) pending.delete(url);
      } catch {
        // Connection refused / DNS not up yet — expected mid-startup.
      }
    }
    if (pending.size === 0) return { ok: true };
    if (Date.now() >= deadline) {
      return { ok: false, error: `timed out after ${input.timeoutMs}ms waiting for: ${[...pending].join(", ")}` };
    }
    await sleep(input.intervalMs);
  }
}

/** A minimal structural subset of Node's real `ChildProcess` (kill/once/killed) — satisfied by a real spawned child at the real call site, and by a small fake in tests, so shutdown coordination never needs to spawn a real process to be unit-tested. */
export interface ChildLike {
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface ShutdownOptions {
  graceMs: number;
  signal?: NodeJS.Signals;
}

/**
 * Forwards `signal` (default SIGTERM) to every still-alive child, then
 * waits up to `graceMs` for each to report its own "exit" event before
 * escalating to SIGKILL on any straggler. Must NOT SIGKILL immediately:
 * `aart server`/`aart worker` already drain in-flight work on SIGTERM
 * (process.ts's own `waitForShutdownSignal` + `handle.close()`/
 * `handle.stop()`; DEPLOY.md: "drains in-flight steps to their next
 * checkpoint before exiting") — an immediate SIGKILL would defeat that.
 */
export async function shutdownChildren(children: readonly ChildLike[], options: ShutdownOptions): Promise<void> {
  const signal = options.signal ?? "SIGTERM";
  const alive = children.filter((c) => !c.killed);
  await Promise.all(
    alive.map(
      (child) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
            resolve();
          }, options.graceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill(signal);
        }),
    ),
  );
}

/** Pure — no I/O. Returns `undefined` for a platform with no known opener (best-effort caller prints the URL instead of crashing; see `openBrowser`). */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): { bin: string; args: string[] } | undefined {
  if (platform === "darwin") return { bin: "open", args: [url] };
  if (platform === "linux") return { bin: "xdg-open", args: [url] };
  // Windows: `start` is a cmd.exe builtin, not a standalone binary — invoked
  // via `cmd /c`. The empty `""` argument is `start`'s own documented
  // window-title parameter; omitting it lets `start` misparse a quoted URL
  // as the title instead of the target. Unverified on real Windows (this
  // repo has no Windows CI or deploy target — Dockerfile/docker-compose.yml
  // are Debian-only) — best-effort, same as the other two platforms.
  if (platform === "win32") return { bin: "cmd", args: ["/c", "start", '""', url] };
  return undefined;
}

/** Best-effort, never throws: a missing opener binary or an unrecognized platform must not crash `aart watch` — the caller always prints the dashboard URL regardless (see watchCommand below), matching the brief's "best-effort; if the opener fails, print the URL and continue." Detached + unref'd so the opener helper process (which typically exits almost immediately after handing off to the real browser) never keeps `aart watch`'s own event loop alive and is never mistaken for one of the three supervised children. */
export function openBrowser(url: string): void {
  const command = browserOpenCommand(process.platform, url);
  if (!command) return;
  try {
    spawn(command.bin, command.args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Best-effort — see doc comment above.
  }
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * `aart watch` — boots server + worker + dashboard as three supervised
 * child processes, streams their logs (prefixed) to this process's own
 * stdout, waits for all three `/health` endpoints, opens a browser, then
 * blocks until SIGTERM/SIGINT (or a child exits unexpectedly) before
 * gracefully shutting every child down.
 *
 * Deliberately prints directly to stdout throughout (startup banner, live
 * interleaved child logs, the "all ready" line, the "stopping…" line)
 * rather than returning everything in the final `HandlerResult` the way
 * every other command in this package does (commands/remote.ts's own doc
 * comment: "return structured data, never console.* — verified: zero
 * console.* calls anywhere under packages/cli/src", true for every OTHER
 * command). `aart watch` is architecturally a different shape: a long-
 * running foreground supervisor a human operator watches live, not a
 * request/response command a script parses JSON from — the one existing
 * precedent for that same shape in this codebase, `deploy/serve-
 * dashboard.mjs`, uses `console.log`/`console.error` directly for exactly
 * this reason. The final `HandlerResult` returned once shutdown completes
 * keeps `bin.ts`'s own unconditional `JSON.stringify(outcome.result)` print
 * working the same as every other command, it just isn't the ONLY output.
 */
export async function watchCommand(tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const cliEntryPath = process.argv[1];
  if (!cliEntryPath) {
    return { ok: false, error: "aart watch: could not determine the running CLI entry point (process.argv[1] is empty) — this should never happen for a real `aart` invocation." };
  }

  const paths = resolveWatchPaths(cliEntryPath);
  const precondition = checkWatchPreconditions(paths);
  if (!precondition.ok) return { ok: false, error: precondition.error };

  const config = resolveWatchConfig(tokens, cli);
  // resolveDeployToken (secrets.ts) — NOT just `process.env.AART_DEPLOY_TOKEN`
  // inherited via the dashboard child's env spread below: it also falls back
  // to `<root>/secrets.json`'s own AART_DEPLOY_TOKEN key (the same dev-
  // convenience file real-server-port.ts's own startServer already resolves
  // this from for the spawned server child), which plain env inheritance
  // would miss entirely.
  const deployToken = await resolveDeployToken(config.root);

  print(
    `[watch] starting — server 127.0.0.1:${config.serverPort}, worker health :${config.workerHealthPort}, dashboard :${config.dashboardPort} (store=${config.store}, root=${config.root})`,
  );

  const serverChild = spawn(process.execPath, [cliEntryPath, ...buildServerSpawnArgs(config)], { stdio: ["ignore", "pipe", "pipe"] });
  const workerChild = spawn(process.execPath, [cliEntryPath, ...buildWorkerSpawnArgs(config)], { stdio: ["ignore", "pipe", "pipe"] });
  const dashboardChild = spawn(process.execPath, [paths.serveDashboardScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildDashboardEnv({ ...config, deployToken }),
  });

  const labeled: Array<{ label: string; child: ChildProcess }> = [
    { label: "server", child: serverChild },
    { label: "worker", child: workerChild },
    { label: "dashboard", child: dashboardChild },
  ];

  for (const { label, child } of labeled) {
    const prefixer = createLinePrefixer(label, print);
    child.stdout?.on("data", (chunk: Buffer) => prefixer.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => prefixer.write(chunk));
    child.once("exit", () => prefixer.flush());
  }

  // A child that dies before we've EITHER become ready OR started our own
  // intentional shutdown is a startup/runtime failure, not a normal stop —
  // e.g. a port already in use, or (commands/cli.ts's own
  // assertServerRootExists, inherited for free by the re-exec'd `aart
  // server`/`aart worker` children) a misconfigured --root. Racing this
  // against both the readiness poll and the blocking wait below means such
  // a failure is reported promptly, with the real error already visible
  // moments earlier in this same terminal (the crashed child's own
  // prefixed log lines), instead of `aart watch` hanging for the full
  // readiness timeout or forever waiting for a SIGTERM that will never come.
  //
  // Also listens for each child's own "error" event (spawn-level failure —
  // e.g. ENOENT) alongside "exit": Node's EventEmitter throws on an
  // unhandled "error" event, which would otherwise crash `aart watch`
  // itself with a raw stack trace instead of the clean message every other
  // failure path in this function produces. Mirrors the one other real
  // precedent for handling this in this codebase (packages/blocks-core/src/
  // lib/command-spawn.ts's own `child.on("error", ...)`).
  let intentionalShutdown = false;
  const earlyExit = new Promise<PollResult>((resolve) => {
    for (const { label, child } of labeled) {
      child.once("exit", (code, signal) => {
        if (intentionalShutdown) return;
        resolve({ ok: false, error: `${label} exited unexpectedly before "aart watch" finished starting up (code=${code ?? "null"}, signal=${signal ?? "null"}) — see its [${label}] log lines above.` });
      });
      child.once("error", (err) => {
        if (intentionalShutdown) return;
        resolve({ ok: false, error: `${label} failed to start: ${err.message}` });
      });
    }
  });

  const readiness = await Promise.race([
    pollUntilReady({
      urls: [`http://127.0.0.1:${config.serverPort}/health`, `http://127.0.0.1:${config.workerHealthPort}/health`, `http://127.0.0.1:${config.dashboardPort}/health`],
      timeoutMs: WATCH_READY_TIMEOUT_MS,
      intervalMs: WATCH_READY_POLL_INTERVAL_MS,
    }),
    earlyExit,
  ]);

  if (!readiness.ok) {
    intentionalShutdown = true;
    await shutdownChildren(labeled.map((c) => c.child), { graceMs: WATCH_SHUTDOWN_GRACE_MS });
    return { ok: false, error: `aart watch: ${readiness.error}` };
  }

  const dashboardUrl = `http://localhost:${config.dashboardPort}`;
  print(`[watch] all ready → open ${dashboardUrl}`);
  openBrowser(dashboardUrl);

  // Distinguishes WHY the blocking wait ended: a normal SIGTERM/SIGINT
  // (crashReason stays undefined) vs. a child crashing after we were
  // already up and running (earlyExit's listeners are still armed —
  // registered once, above, before readiness — so a post-ready crash is
  // caught here too, not just a pre-ready one). Without this distinction
  // the final HandlerResult would report `ok: true, "Watch stopped."` even
  // when the real cause was a mid-run crash, which is misleading — the
  // OPPOSITE of what commands/process.ts's own serverCommand/workerCommand
  // do (their `ok: true` genuinely only means "stopped cleanly").
  let crashReason: string | undefined;
  if (options.blocking ?? true) {
    crashReason = await Promise.race([
      waitForShutdownSignal().then((): string | undefined => undefined),
      earlyExit.then((result): string | undefined => (result.ok ? undefined : result.error)),
    ]);
  }

  intentionalShutdown = true;
  print("[watch] stopping…");
  await shutdownChildren(labeled.map((c) => c.child), { graceMs: WATCH_SHUTDOWN_GRACE_MS });
  print("[watch] stopped.");

  if (crashReason) {
    return { ok: false, error: `aart watch: ${crashReason}` };
  }
  return { ok: true, message: "Watch stopped.", ports: { server: config.serverPort, worker: config.workerHealthPort, dashboard: config.dashboardPort } };
}
