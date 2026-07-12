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

  it("resolves packages/dashboard/dist two levels up from the CLI's own dist dir", () => {
    const paths = resolveWatchPaths("/repo/packages/cli/dist/bin.js");
    expect(paths.dashboardDistDir).toBe("/repo/packages/dashboard/dist");
  });

  it("works identically whether the CLI entry is nested (e.g. run from source) -- purely a function of the entry's own directory", () => {
    const paths = resolveWatchPaths("/checkout/packages/cli/src/bin.ts");
    expect(paths.serveDashboardScript).toBe("/checkout/packages/cli/src/serve-dashboard.mjs");
    expect(paths.dashboardDistDir).toBe("/checkout/packages/dashboard/dist");
  });
});

describe("checkWatchPreconditions", () => {
  // Fixtures write index.html under "<dashboardDistDir>/frontend/", NOT
  // directly under dashboardDistDir -- verified live against a real `pnpm
  // run build` before this was pinned in a test at all: packages/dashboard/
  // frontend/vite.config.ts's `build.outDir: '../dist/frontend'` really does
  // land the SPA at packages/dashboard/dist/frontend/index.html. An earlier
  // draft of this function (and these fixtures) checked
  // "<dashboardDistDir>/index.html" directly -- self-consistent with itself,
  // but wrong against the real repo layout, which only a live run against
  // the actual built artifacts caught (a real `aart watch` reported the
  // dashboard frontend as missing even though `pnpm run build` had just
  // built it) -- fixed here alongside the implementation, not just in it.
  it("ok when both the dashboard frontend (under frontend/) and the launcher script exist", async () => {
    const dashboardDistDir = await freshDir();
    await fs.mkdir(path.join(dashboardDistDir, "frontend"), { recursive: true });
    await fs.writeFile(path.join(dashboardDistDir, "frontend", "index.html"), "<html></html>", "utf8");
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs");
    await fs.writeFile(serveDashboardScript, "// stub", "utf8");

    expect(checkWatchPreconditions({ dashboardDistDir, serveDashboardScript })).toEqual({ ok: true });
  });

  it("refuses, naming the frontend specifically, when packages/dashboard/dist exists but has no frontend/index.html (a bare tsc -b output with no SPA build)", async () => {
    const dashboardDistDir = await freshDir(); // directory exists, deliberately no frontend/index.html written
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs");
    await fs.writeFile(serveDashboardScript, "// stub", "utf8");

    const result = checkWatchPreconditions({ dashboardDistDir, serveDashboardScript });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dashboard frontend");
    expect(result.error).toContain(path.join(dashboardDistDir, "frontend", "index.html"));
    expect(result.error).not.toContain("dashboard launcher");
  });

  it("a bare dashboardDistDir with an index.html directly inside it (not under frontend/) still counts as missing -- the exact regression this suite now pins", async () => {
    const dashboardDistDir = await freshDir();
    await fs.writeFile(path.join(dashboardDistDir, "index.html"), "<html></html>", "utf8"); // wrong location on purpose
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs");
    await fs.writeFile(serveDashboardScript, "// stub", "utf8");

    const result = checkWatchPreconditions({ dashboardDistDir, serveDashboardScript });
    expect(result.ok).toBe(false);
  });

  it("refuses, naming build:dashboard-launcher specifically, when only the launcher script is missing", async () => {
    const dashboardDistDir = await freshDir();
    await fs.mkdir(path.join(dashboardDistDir, "frontend"), { recursive: true });
    await fs.writeFile(path.join(dashboardDistDir, "frontend", "index.html"), "<html></html>", "utf8");
    const serveDashboardScript = path.join(await freshDir(), "serve-dashboard.mjs"); // never written

    const result = checkWatchPreconditions({ dashboardDistDir, serveDashboardScript });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dashboard launcher");
    expect(result.error).toContain("build:dashboard-launcher");
    expect(result.error).not.toContain("dashboard frontend");
  });

  it("refuses, naming both, when neither artifact exists -- remedy still only mentions pnpm run build once each, not a surprise multi-minute build", async () => {
    const dashboardDistDir = path.join(await freshDir(), "does-not-exist");
    const serveDashboardScript = path.join(await freshDir(), "does-not-exist", "serve-dashboard.mjs");

    const result = checkWatchPreconditions({ dashboardDistDir, serveDashboardScript });
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
    const env = buildDashboardEnv({ serverPort: 8080, dashboardPort: 4000, workerHealthPort: 8787, store: "fs", root: "/r", deployToken: undefined, baseEnv: {} });
    expect(env).toEqual({
      AART_SERVER_URL: "http://127.0.0.1:8080",
      AART_STORE: "fs",
      AART_ROOT: "/r",
      AART_DASHBOARD_PORT: "4000",
      AART_WORKER_URLS: "http://127.0.0.1:8787",
    });
  });

  it("includes AART_DEPLOY_TOKEN only when configured", () => {
    const env = buildDashboardEnv({ serverPort: 8080, dashboardPort: 4000, workerHealthPort: 8787, store: "fs", root: "/r", deployToken: "secret-token", baseEnv: {} });
    expect(env["AART_DEPLOY_TOKEN"]).toBe("secret-token");
  });

  it("spreads baseEnv underneath the explicit keys -- inherited vars survive, but explicit keys always win on collision", () => {
    const env = buildDashboardEnv({
      serverPort: 9090,
      dashboardPort: 5000,
      workerHealthPort: 8787,
      store: "sqlite",
      root: "/custom",
      deployToken: undefined,
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
});

function createFakeChild(): { child: ChildLike; killCalls: NodeJS.Signals[]; emitExit: (code: number | null, signal: NodeJS.Signals | null) => void } {
  let killed = false;
  const killCalls: NodeJS.Signals[] = [];
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const child: ChildLike = {
    get killed(): boolean {
      return killed;
    },
    kill(signal?: NodeJS.Signals): boolean {
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
      killed = true;
      for (const l of listeners.splice(0)) l(code, signal);
    },
  };
}

describe("shutdownChildren", () => {
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

  it("escalates to SIGKILL after graceMs when a child never reports exit", async () => {
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

  it("skips a child that was already killed before shutdownChildren was even called", async () => {
    const a = createFakeChild();
    a.emitExit(0, "SIGTERM");
    await shutdownChildren([a.child], { graceMs: 20 });
    expect(a.killCalls).toEqual([]); // filtered out via the `!c.killed` pre-check -- never signaled again
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
