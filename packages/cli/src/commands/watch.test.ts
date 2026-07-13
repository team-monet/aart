// aart watch — Wave 2B (AMENDMENTS.md A64). Unit coverage for every pure/
// injectable piece watch.ts factors out: config/path resolution,
// precondition checking, argv/env assembly, the log-line prefixer, the
// readiness poller (fake fetchImpl — no real network), shutdown
// coordination (fake ChildLike set — no real process), and the platform
// browser-opener's pure command-selection logic.
//
// Deliberately NOT covered here (see watch.ts's own module doc comment for
// why): `watchCommand` itself, the top-level orchestration function. It
// spawns three real OS processes (re-executing the CLI entry point) and
// shells out to open a real browser — neither belongs in this repo's fast/
// offline/deterministic CI suite, and the brief this session was built
// against says so explicitly. That full path needs live/manual
// verification against the real built binary instead (a fresh `aart watch`
// run against a real `pnpm run build`, confirming the banner, interleaved
// live logs, browser opening, and Ctrl-C shutdown all work end to end).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../cli-context.js";
import {
  browserOpenCommand,
  buildDashboardEnv,
  buildServerSpawnArgs,
  buildWorkerSpawnArgs,
  checkWatchPreconditions,
  createLinePrefixer,
  pollUntilReady,
  resolveRealCliEntryPath,
  resolveWatchConfig,
  resolveWatchPaths,
  shutdownChildren,
  type ChildLike,
} from "./watch.js";

let cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })));
  cleanupPaths = [];
});

async function freshDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "aart-watch-test-"));
  cleanupPaths.push(dir);
  return dir;
}

describe("resolveWatchConfig", () => {
  const cli: Pick<CliContext, "root"> = { root: "/tmp/aart-root" };

  it("defaults server/dashboard ports, the fixed worker health port, and store when no flags are given", () => {
    expect(resolveWatchConfig({ positionals: [], flags: {} }, cli)).toEqual({
      serverPort: 8080,
      dashboardPort: 4000,
      workerHealthPort: 8787,
      store: "fs",
      root: "/tmp/aart-root",
    });
  });

  it("honors --server-port/--dashboard-port/--store overrides and cli.root for --root", () => {
    const config = resolveWatchConfig({ positionals: [], flags: { "server-port": "9090", "dashboard-port": "5000", store: "sqlite" } }, { root: "/custom/root" });
    expect(config).toEqual({ serverPort: 9090, dashboardPort: 5000, workerHealthPort: 8787, store: "sqlite", root: "/custom/root" });
  });

  it("the worker health port is never flag-configurable (no --worker-port in aart watch's USAGE)", () => {
    const config = resolveWatchConfig({ positionals: [], flags: { "worker-port": "1234" } }, cli);
    expect(config.workerHealthPort).toBe(8787);
  });

  it("defaults to the fs store for any non-sqlite value (defensive -- cli.ts already validates fs|sqlite before dispatch)", () => {
    expect(resolveWatchConfig({ positionals: [], flags: { store: "bogus" } }, cli).store).toBe("fs");
  });
});

describe("resolveWatchPaths", () => {
  it("resolves serve-dashboard.mjs as a sibling of the CLI entry point", () => {
    const paths = resolveWatchPaths("/repo/packages/cli/dist/bin.js");
    expect(paths.cliDistDir).toBe("/repo/packages/cli/dist");
    expect(paths.serveDashboardScript).toBe("/repo/packages/cli/dist/serve-dashboard.mjs");
  });

  // Wave 2 fix pass (AMENDMENTS.md A67 FIX 3): frontendDir replaces the
  // former dashboardDistDir (which pointed at packages/dashboard/dist, two
  // directories up -- a monorepo-only location with no equivalent in a real
  // `npm install -g` global install, where packages/dashboard never ships
  // at all). It's now a direct sibling of serveDashboardScript, matching
  // deploy/build-dashboard-launcher.mjs's own copy target
  // (packages/cli/dist/frontend) in BOTH the monorepo and installed
  // layouts -- this is the successor regression pin for what the old
  // "index.html directly inside dashboardDistDir, not under frontend/,
  // still counts as missing" checkWatchPreconditions test used to cover:
  // the exact nesting level is now decided HERE, once, not re-derived by
  // checkWatchPreconditions.
  it("resolves the frontend dir as a sibling of the CLI entry point, matching build-dashboard-launcher.mjs's own copy target", () => {
    const paths = resolveWatchPaths("/repo/packages/cli/dist/bin.js");
    expect(paths.frontendDir).toBe("/repo/packages/cli/dist/frontend");
  });

  it("works identically whether the CLI entry is nested (e.g. run from source) -- purely a function of the entry's own directory", () => {
    const paths = resolveWatchPaths("/checkout/packages/cli/src/bin.ts");
    expect(paths.serveDashboardScript).toBe("/checkout/packages/cli/src/serve-dashboard.mjs");
    expect(paths.frontendDir).toBe("/checkout/packages/cli/src/frontend");
  });
});

// Wave 2 fix pass (AMENDMENTS.md A67 FIX 3, real-binary-tester finding):
// process.argv[1] for a globally-installed npm package is frequently a
// SYMLINK (npm's bin-shim mechanism) -- resolveWatchPaths must be fed the
// REAL target directory, not the symlink's own directory, or
// serve-dashboard.mjs/frontend/ are looked for in the wrong place entirely.
// Uses REAL temp-dir symlinks (fs.symlink), not a mock -- this is exactly
// the kind of real-OS-semantics behavior a fake can't stand in for, and
// unlike spawning a real child process or opening a real browser, it's
// fast, deterministic, and fully offline, so it belongs in this suite.
describe("resolveRealCliEntryPath", () => {
  it("resolves a real symlink to its target's real directory (npm's global-install bin-shim shape)", async () => {
    const dir = await freshDir();
    const targetDir = path.join(dir, "lib", "node_modules", "@team-monet", "aart", "dist");
    await fs.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, "bin.js");
    await fs.writeFile(target, "// stub", "utf8");
    const linkDir = path.join(dir, "bin");
    await fs.mkdir(linkDir, { recursive: true });
    const link = path.join(linkDir, "aart");
    await fs.symlink(target, link);

    expect(resolveRealCliEntryPath(link)).toBe(await fs.realpath(target));
    // ...and the point of resolving it: sibling paths now derive from the
    // REAL installed dist dir, not from /.../bin (the symlink's own dir,
    // which has no serve-dashboard.mjs/frontend/ beside it at all).
    expect(resolveWatchPaths(resolveRealCliEntryPath(link)).frontendDir).toBe(path.join(await fs.realpath(targetDir), "frontend"));
  });

  it("returns a plain non-symlink path resolved to its own realpath -- not a no-op passthrough, but not throwing either", async () => {
    const dir = await freshDir();
    const file = path.join(dir, "bin.js");
    await fs.writeFile(file, "// stub", "utf8");
    expect(resolveRealCliEntryPath(file)).toBe(await fs.realpath(file));
  });

  it("falls back to the original path, best-effort, if realpath resolution fails (a dangling/nonexistent reference)", () => {
    expect(resolveRealCliEntryPath("/does/not/exist/bin.js")).toBe("/does/not/exist/bin.js");
  });
});

describe("checkWatchPreconditions", () => {
  // Wave 2 fix pass (AMENDMENTS.md A67 FIX 3): `frontendDir` is now the
  // frontend directory itself (resolveWatchPaths's own job to compute the
  // right sibling path, tested separately, above) -- this describe block's
  // own job is just "given a frontendDir, is index.html directly inside
  // it," one level, no more implicit "+ frontend" nesting to get right or
  // wrong here.
  it("ok when both the dashboard frontend and the launcher script exist", async () => {
    const frontendDir = await freshDir();
    await fs.writeFile(path.join(frontendDir, "index.html"), "<html></html>", "utf8");
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs");
    await fs.writeFile(serveDashboardScript, "// stub", "utf8");

    expect(checkWatchPreconditions({ frontendDir, serveDashboardScript })).toEqual({ ok: true });
  });

  it("refuses, naming the frontend specifically, when the frontend dir exists but has no index.html (a partial/interrupted build)", async () => {
    const frontendDir = await freshDir(); // directory exists, deliberately no index.html written
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs");
    await fs.writeFile(serveDashboardScript, "// stub", "utf8");

    const result = checkWatchPreconditions({ frontendDir, serveDashboardScript });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dashboard frontend");
    expect(result.error).toContain(path.join(frontendDir, "index.html"));
    expect(result.error).not.toContain("dashboard launcher");
  });

  it("refuses, naming build:dashboard-launcher specifically, when only the launcher script is missing", async () => {
    const frontendDir = await freshDir();
    await fs.writeFile(path.join(frontendDir, "index.html"), "<html></html>", "utf8");
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs"); // never written

    const result = checkWatchPreconditions({ frontendDir, serveDashboardScript });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dashboard launcher");
    expect(result.error).toContain("build:dashboard-launcher");
    expect(result.error).not.toContain("dashboard frontend");
  });

  it("refuses, naming both, when neither artifact exists -- remedy still only mentions pnpm run build once each, not a surprise multi-minute build", async () => {
    const frontendDir = path.join(await freshDir(), "does-not-exist");
    const serveDashboardScript = path.join(await freshDir(), "does-not-exist", "serve-dashboard.mjs");

    const result = checkWatchPreconditions({ frontendDir, serveDashboardScript });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dashboard frontend");
    expect(result.error).toContain("dashboard launcher");
    expect(result.error).toContain("pnpm run build");
  });
});

describe("buildServerSpawnArgs", () => {
  it("builds the exact argv aart server itself parses (commands/process.ts's serverCommand), bound to 127.0.0.1", () => {
    expect(buildServerSpawnArgs({ serverPort: 8080, store: "fs", root: "/r" })).toEqual(["server", "--port", "8080", "--host", "127.0.0.1", "--store", "fs", "--root", "/r"]);
  });

  it("reflects a non-default port and sqlite store", () => {
    expect(buildServerSpawnArgs({ serverPort: 19090, store: "sqlite", root: "/custom/root" })).toEqual([
      "server",
      "--port",
      "19090",
      "--host",
      "127.0.0.1",
      "--store",
      "sqlite",
      "--root",
      "/custom/root",
    ]);
  });
});

describe("buildWorkerSpawnArgs", () => {
  it("builds the exact argv aart worker itself parses (commands/process.ts's workerCommand) -- no port flag, workerCommand reads none", () => {
    expect(buildWorkerSpawnArgs({ store: "sqlite", root: "/r" })).toEqual(["worker", "--root", "/r", "--store", "sqlite"]);
  });
});

describe("buildDashboardEnv", () => {
  it("assembles exactly the env vars deploy/serve-dashboard.mjs reads, omitting AART_DEPLOY_TOKEN when unconfigured", () => {
    const env = buildDashboardEnv({ serverPort: 8080, dashboardPort: 4000, workerHealthPort: 8787, store: "fs", root: "/r", deployToken: undefined, frontendDir: "/r/dist/frontend", baseEnv: {} });
    expect(env).toEqual({
      AART_SERVER_URL: "http://127.0.0.1:8080",
      AART_STORE: "fs",
      AART_ROOT: "/r",
      AART_DASHBOARD_PORT: "4000",
      AART_WORKER_URLS: "http://127.0.0.1:8787",
      AART_DASHBOARD_FRONTEND_DIR: "/r/dist/frontend",
    });
  });

  it("includes AART_DEPLOY_TOKEN only when configured", () => {
    const env = buildDashboardEnv({ serverPort: 8080, dashboardPort: 4000, workerHealthPort: 8787, store: "fs", root: "/r", deployToken: "secret-token", frontendDir: "/r/dist/frontend", baseEnv: {} });
    expect(env["AART_DEPLOY_TOKEN"]).toBe("secret-token");
  });

  // Wave 2 fix pass (AMENDMENTS.md A67 FIX 3) -- belt-and-braces: `aart
  // watch` already knows the resolved frontend dir from its own path
  // resolution (resolveWatchPaths), and tells the dashboard child directly
  // rather than relying solely on the child re-deriving the same answer.
  it("always sets AART_DASHBOARD_FRONTEND_DIR to the resolved frontend dir", () => {
    const env = buildDashboardEnv({ serverPort: 8080, dashboardPort: 4000, workerHealthPort: 8787, store: "fs", root: "/r", deployToken: undefined, frontendDir: "/custom/dist/frontend", baseEnv: {} });
    expect(env["AART_DASHBOARD_FRONTEND_DIR"]).toBe("/custom/dist/frontend");
  });

  it("spreads baseEnv underneath the explicit keys -- inherited vars survive, but explicit keys always win on collision", () => {
    const env = buildDashboardEnv({
      serverPort: 9090,
      dashboardPort: 5000,
      workerHealthPort: 8787,
      store: "sqlite",
      root: "/custom",
      deployToken: undefined,
      frontendDir: "/custom/dist/frontend",
      baseEnv: { PATH: "/usr/bin", AART_ROOT: "should-be-overridden" },
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["AART_ROOT"]).toBe("/custom");
    expect(env["AART_STORE"]).toBe("sqlite");
  });
});

describe("createLinePrefixer", () => {
  it("prefixes a single complete line", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("server", (l) => lines.push(l));
    p.write(Buffer.from("hello world\n"));
    expect(lines).toEqual(["[server] hello world"]);
  });

  it("buffers a partial line across chunk boundaries and emits once it's complete", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("worker", (l) => lines.push(l));
    p.write(Buffer.from("hel"));
    expect(lines).toEqual([]); // nothing yet -- no newline seen
    p.write(Buffer.from("lo\n"));
    expect(lines).toEqual(["[worker] hello"]);
  });

  it("emits multiple lines contained in a single chunk, in order", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("dashboard", (l) => lines.push(l));
    p.write(Buffer.from("one\ntwo\nthree\n"));
    expect(lines).toEqual(["[dashboard] one", "[dashboard] two", "[dashboard] three"]);
  });

  it("holds back a trailing partial line with no newline until flush() is called", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("server", (l) => lines.push(l));
    p.write(Buffer.from("no newline yet"));
    expect(lines).toEqual([]);
    p.flush();
    expect(lines).toEqual(["[server] no newline yet"]);
  });

  it("flush() is a no-op when there's no trailing partial line (never emits a spurious empty line)", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("server", (l) => lines.push(l));
    p.write(Buffer.from("complete\n"));
    p.flush();
    expect(lines).toEqual(["[server] complete"]);
  });
});

describe("pollUntilReady", () => {
  it("resolves ok once every url returns a 2xx response on the first attempt", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      calls.push(String(url));
      return { ok: true } as Response;
    }) as typeof fetch;

    const result = await pollUntilReady({ urls: ["http://a", "http://b"], timeoutMs: 1000, intervalMs: 5, fetchImpl: fakeFetch });
    expect(result).toEqual({ ok: true });
    expect(calls.sort()).toEqual(["http://a", "http://b"]);
  });

  it("retries a url whose fetch rejects (connection refused, not listening yet) before eventually succeeding", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return { ok: true } as Response;
    }) as typeof fetch;

    const result = await pollUntilReady({ urls: ["http://a"], timeoutMs: 1000, intervalMs: 5, fetchImpl: fakeFetch });
    expect(result).toEqual({ ok: true });
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("retries a url that returns a non-2xx response before eventually succeeding", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      return { ok: attempts >= 2 } as Response;
    }) as typeof fetch;

    const result = await pollUntilReady({ urls: ["http://a"], timeoutMs: 1000, intervalMs: 5, fetchImpl: fakeFetch });
    expect(result).toEqual({ ok: true });
  });

  it("times out and reports exactly the urls still pending when none ever succeed", async () => {
    const fakeFetch = (async () => ({ ok: false }) as Response) as typeof fetch;

    const result = await pollUntilReady({ urls: ["http://a", "http://b"], timeoutMs: 30, intervalMs: 5, fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("http://a");
    expect(result.error).toContain("http://b");
  });

  it("stops re-checking a url once it has already succeeded, even while other urls are still pending", async () => {
    const callsPerUrl: Record<string, number> = {};
    const fakeFetch = (async (url: string | URL) => {
      const key = String(url);
      callsPerUrl[key] = (callsPerUrl[key] ?? 0) + 1;
      return { ok: key === "http://fast" } as Response;
    }) as typeof fetch;

    await pollUntilReady({ urls: ["http://fast", "http://slow"], timeoutMs: 60, intervalMs: 5, fetchImpl: fakeFetch });
    expect(callsPerUrl["http://fast"]).toBe(1);
    expect(callsPerUrl["http://slow"]).toBeGreaterThan(1);
  });

  // Wave 2 fix pass (AMENDMENTS.md A67 FIX 5, real-binary-tester finding):
  // Node's fetch has no default per-request timeout -- a "connected but
  // wedged" endpoint (accepts the TCP connection, never actually responds)
  // used to hang that ONE fetch call forever, since the overall `timeoutMs`
  // deadline is only ever checked BETWEEN awaited attempts, never
  // interrupts one already in flight.
  it("bounds each individual request with a per-request AbortSignal timeout, so a connected-but-wedged endpoint can't hang a poll attempt forever", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fakeFetch = ((_url: string | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        // Mirrors what a REAL fetch does when its AbortSignal fires -- the
        // promise rejects, it never just hangs unresolved. Deliberately
        // never resolves on its own otherwise (the "wedged" endpoint).
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    }) as typeof fetch;

    const result = await pollUntilReady({ urls: ["http://wedged"], timeoutMs: 100, intervalMs: 10, requestTimeoutMs: 15, fetchImpl: fakeFetch });

    expect(receivedSignal).toBeInstanceOf(AbortSignal); // a signal was actually wired through to fetchImpl
    expect(result.ok).toBe(false); // never actually became ready -- the point is that this resolves AT ALL (within the test's own timeout), not that it succeeds
  });
});

/**
 * Wave 2 fix pass (AMENDMENTS.md A67 FIX 2, MANDATORY fixture fix): this
 * fixture used to set `killed = true` inside `emitExit()` -- CONFLATING
 * "exited on its own" with "killed by us," the exact wrong mental model
 * that hid shutdownChildren's own dead-code SIGKILL escalation from every
 * test in this file (a self-consistent fixture + a self-consistent
 * implementation, built around the same wrong assumption, agreed with each
 * other and hid the bug from this entire suite -- only real esbuild
 * bundling / a real npm symlink / real OS process timing ever surfaced it).
 * Fixed to model REAL Node child_process semantics precisely:
 *   - `.kill()` sets `killed = true` SYNCHRONOUSLY, the moment the signal
 *     is sent -- exactly like real Node -- but never touches
 *     exitCode/signalCode (sending a signal is not the same as the process
 *     having actually died).
 *   - `emitExit()` sets `exitCode`/`signalCode` (never `killed`) -- a
 *     self-exit (crash) that nothing ever called `.kill()` on leaves
 *     `killed` false FOREVER, exactly like real Node.
 */
function createFakeChild(): { child: ChildLike; killCalls: NodeJS.Signals[]; emitExit: (code: number | null, signal: NodeJS.Signals | null) => void } {
  let killed = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const killCalls: NodeJS.Signals[] = [];
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const child: ChildLike = {
    get killed(): boolean {
      return killed;
    },
    get exitCode(): number | null {
      return exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return signalCode;
    },
    kill(signal?: NodeJS.Signals): boolean {
      killed = true;
      killCalls.push(signal ?? "SIGTERM");
      return true;
    },
    once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
      listeners.push(listener);
    },
  };
  return {
    child,
    killCalls,
    emitExit(code, signal) {
      exitCode = code;
      signalCode = signal;
      for (const l of listeners.splice(0)) l(code, signal);
    },
  };
}

describe("shutdownChildren", () => {
  // (iii) normal SIGTERM-then-exits -- resolves promptly, no escalation.
  it("sends SIGTERM and resolves without escalating once every child reports its own exit", async () => {
    const a = createFakeChild();
    const b = createFakeChild();
    const done = shutdownChildren([a.child, b.child], { graceMs: 5000 });
    a.emitExit(0, null);
    b.emitExit(0, null);
    await done;
    expect(a.killCalls).toEqual(["SIGTERM"]);
    expect(b.killCalls).toEqual(["SIGTERM"]);
  });

  // (ii) a child that ignores SIGTERM actually receives SIGKILL after
  // graceMs. THE regression test for the dead-code bug: against the
  // pre-fix `if (!child.killed) child.kill("SIGKILL")`, `child.killed` is
  // already `true` by the time this timer fires (set synchronously inside
  // `.kill(signal)` above it, correctly modeled by THIS fixture's own
  // `.kill()` now) -- so the pre-fix implementation NEVER sends SIGKILL,
  // for any child, ever. Verified failing against the pre-fix
  // implementation before landing the fix (see the developer's own return
  // for the exact command/output).
  it("escalates to SIGKILL after graceMs when a child ignores SIGTERM and never exits", async () => {
    const a = createFakeChild();
    await shutdownChildren([a.child], { graceMs: 20 });
    expect(a.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("handles a mixed set independently -- one child exits promptly, the other needs SIGKILL", async () => {
    const fast = createFakeChild();
    const slow = createFakeChild();
    const done = shutdownChildren([fast.child, slow.child], { graceMs: 20 });
    fast.emitExit(0, null);
    await done;
    expect(fast.killCalls).toEqual(["SIGTERM"]);
    expect(slow.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
  });

  // (i) a child that self-exits (crashes) BEFORE shutdown is called
  // resolves promptly, with no graceMs stall -- the second bug this fix
  // pass closes. `graceMs` is deliberately far larger than vitest's own
  // default test timeout: if shutdownChildren regressed to stalling this
  // child for the full graceMs (the pre-fix behavior for THIS scenario
  // would actually have "worked" by accident under the OLD fixture, which
  // is exactly why the fixture itself had to be fixed too -- see this
  // fixture's own doc comment), this test would time out and fail, not
  // just report a wrong value.
  it("a child that already self-exited (crashed) before shutdownChildren was even called resolves promptly, without stalling for graceMs or re-signaling it", async () => {
    const a = createFakeChild();
    a.emitExit(1, null); // self-exited (e.g. a crash) -- nothing ever called .kill() on it
    await shutdownChildren([a.child], { graceMs: 10_000 });
    expect(a.killCalls).toEqual([]); // filtered out of `alive` entirely via hasExited() -- never signaled, never re-checked
  });

  it("honors a custom shutdown signal instead of the SIGTERM default", async () => {
    const a = createFakeChild();
    const done = shutdownChildren([a.child], { graceMs: 5000, signal: "SIGINT" });
    a.emitExit(0, "SIGINT");
    await done;
    expect(a.killCalls).toEqual(["SIGINT"]);
  });
});

describe("browserOpenCommand", () => {
  it("darwin -> open", () => {
    expect(browserOpenCommand("darwin", "http://localhost:4000")).toEqual({ bin: "open", args: ["http://localhost:4000"] });
  });

  it("linux -> xdg-open", () => {
    expect(browserOpenCommand("linux", "http://localhost:4000")).toEqual({ bin: "xdg-open", args: ["http://localhost:4000"] });
  });

  it("win32 -> cmd /c start, with the empty-title argument so the URL isn't misparsed as start's window title", () => {
    expect(browserOpenCommand("win32", "http://localhost:4000")).toEqual({ bin: "cmd", args: ["/c", "start", '""', "http://localhost:4000"] });
  });

  it("an unrecognized platform returns undefined -- best-effort no-op, never a throw", () => {
    expect(browserOpenCommand("aix", "http://localhost:4000")).toBeUndefined();
  });
});
