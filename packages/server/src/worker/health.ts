// GET /health — architecture ADR-16/§16: "the worker's own lightweight HTTP
// listener, separate from the control-plane API... returning { status,
// claimedRuns, uptime, version }." This is what the §35.3 production
// dashboard's worker-health page polls per registered worker (this
// session's DoD).
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface HealthPayload {
  status: "ok";
  claimedRuns: number;
  uptime: number;
  version: string;
}

function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/worker/health.js (built) or src/worker/health.ts (ts-node/vitest)
    // are both one level below the package root.
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface HealthServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Starts the health listener. `claimedRunsProvider` is called fresh on every request (not snapshotted at startup) so `/health` always reflects the worker's current claim count. */
export function startHealthServer(port: number, claimedRunsProvider: () => number, startedAt: Date = new Date()): Promise<HealthServerHandle> {
  const version = resolveVersion();
  const server = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const payload: HealthPayload = {
        status: "ok",
        claimedRuns: claimedRunsProvider(),
        uptime: (Date.now() - startedAt.getTime()) / 1000,
        version,
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
