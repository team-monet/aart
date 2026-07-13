// GET /health — architecture ADR-16/§16: "the worker's own lightweight HTTP
// listener, separate from the control-plane API... returning { status,
// claimedRuns, uptime, version }." This is what the §35.3 production
// dashboard's worker-health page polls per registered worker (this
// session's DoD).
import { createServer, type Server } from "node:http";

export interface HealthPayload {
  status: "ok";
  claimedRuns: number;
  uptime: number;
  version: string;
}

/**
 * The published `@team-monet/aart` CLI's version — `packages/cli/src/
 * cli.ts`'s own `VERSION` constant, NOT this package's own `package.json`
 * "version" field (frozen at "0.1.0" by deliberate choice, AMENDMENTS.md
 * A68 §1: `@aart/server` is one of 13 private, never-independently-
 * published internal packages, so its own version number carries no
 * external meaning). `aart worker` IS the published CLI, just a different
 * subcommand of the exact same `dist/bin.js` bundle that serves `aart
 * --version` — an operator polling this worker's `/health` expects the
 * SAME version number `aart --version` reports for the binary that started
 * it, not this internal package's own inert number.
 *
 * Hardcoded, not read from a `package.json` at runtime, for the exact same
 * reason `cli.ts`'s own `VERSION` is hardcoded (see that constant's doc
 * comment): `packages/cli`'s esbuild bundle (`build:publish`) inlines this
 * whole file into a single self-contained `dist/bin.js`, at which point an
 * `import.meta.url`/`__dirname`-relative read no longer points at this
 * package's own directory — it points at wherever the BUNDLE physically
 * runs from. The previous implementation (a `resolveVersion()` function
 * doing `readFileSync(join(here, "..", "..", "package.json"))`) assumed the
 * unbundled `packages/server/dist/worker/health.js` layout, silently broke
 * under bundling, and shipped exactly that way in 0.10.0 pre-release
 * builds: the real published `aart worker`'s `GET /health` reported
 * `"0.0.0"` (a thrown-and-caught ENOENT two levels up from wherever
 * esbuild's bundle actually landed, falling through to that function's own
 * hardcoded catch-block fallback) — worker status/claimedRuns/uptime were
 * unaffected, this was cosmetic but real. Found and flagged, not fixed, by
 * AMENDMENTS.md A68 (deviation 6); fixed here (A69).
 *
 * MUST be bumped by hand alongside `packages/cli/src/cli.ts`'s `VERSION`
 * whenever `packages/cli/package.json`'s own version changes — the same
 * accepted hand-maintained-duplicate trade-off `cli.ts`'s own `VERSION`
 * already documents (no dynamic read survives bundling, so there is no
 * automatic alternative). Two independent literals rather than one shared
 * import, because `@aart/server` cannot depend on `@aart/cli` (the CLI
 * depends on the server package, never the reverse — this package's own
 * layering). Threading the real value through `WorkerConfig`/`startWorker`
 * from the CLI's own `VERSION` instead (so there's only one literal, not
 * two) was considered and rejected as disproportionate to a release-
 * quality fix: it would touch `WorkerConfig`, `startWorker`,
 * `workerCommand`, and every test constructing a worker, for a value that
 * only ever changes at release-cut time — the same cadence as this
 * constant's own hand-edit.
 */
export const PUBLISHED_CLI_VERSION = "0.10.0";

export interface HealthServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Starts the health listener. `claimedRunsProvider` is called fresh on every request (not snapshotted at startup) so `/health` always reflects the worker's current claim count. */
export function startHealthServer(port: number, claimedRunsProvider: () => number, startedAt: Date = new Date()): Promise<HealthServerHandle> {
  const server = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const payload: HealthPayload = {
        status: "ok",
        claimedRuns: claimedRunsProvider(),
        uptime: (Date.now() - startedAt.getTime()) / 1000,
        version: PUBLISHED_CLI_VERSION,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: boundPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
