// D1 "remotes + push" (AMENDMENTS.md A56).
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { postBundleEnvelope } from "./deploy-client.js";

let server: Server | undefined;
let baseUrl: string | undefined;
let lastRequest: { path: string; headers: Record<string, string | string[] | undefined>; body: unknown } | undefined;
let nextResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  baseUrl = undefined;
  lastRequest = undefined;
  nextResponse = { status: 200, body: { ok: true } };
});

async function startFakeServer(): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      lastRequest = { path: req.url ?? "", headers: req.headers, body: raw.length > 0 ? JSON.parse(raw) : undefined };
      res.writeHead(nextResponse.status, { "content-type": "application/json" });
      res.end(nextResponse.body === undefined ? "" : JSON.stringify(nextResponse.body));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, () => {
      const address = server!.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  baseUrl = `http://localhost:${port}`;
  return baseUrl;
}

describe("postBundleEnvelope", () => {
  it("POSTs { files } as JSON to <remoteUrl><path>", async () => {
    const url = await startFakeServer();
    await postBundleEnvelope(url, "/bundles/ingest", undefined, { "manifest.json": "{}" });
    expect(lastRequest?.path).toBe("/bundles/ingest");
    expect(lastRequest?.body).toEqual({ files: { "manifest.json": "{}" } });
  });

  it("includes an Authorization: Bearer <token> header when a token is given", async () => {
    const url = await startFakeServer();
    await postBundleEnvelope(url, "/bundles/ingest", "my-token", { "manifest.json": "{}" });
    expect(lastRequest?.headers["authorization"]).toBe("Bearer my-token");
  });

  it("omits the Authorization header entirely when no token is given", async () => {
    const url = await startFakeServer();
    await postBundleEnvelope(url, "/bundles/ingest", undefined, { "manifest.json": "{}" });
    expect(lastRequest?.headers["authorization"]).toBeUndefined();
  });

  it("targets /bundles/plan when that path is given", async () => {
    const url = await startFakeServer();
    await postBundleEnvelope(url, "/bundles/plan", undefined, { "manifest.json": "{}" });
    expect(lastRequest?.path).toBe("/bundles/plan");
  });

  it("returns { status, body } for a successful response, never throws on the response shape", async () => {
    const url = await startFakeServer();
    nextResponse = { status: 200, body: { kind: "hydrated", deploymentId: "bundle:wf@1:env_x" } };
    const result = await postBundleEnvelope(url, "/bundles/ingest", undefined, {});
    expect(result).toEqual({ status: 200, body: { kind: "hydrated", deploymentId: "bundle:wf@1:env_x" } });
  });

  it("returns { status, body } for a non-2xx response too — does not throw", async () => {
    const url = await startFakeServer();
    nextResponse = { status: 401, body: { error: "Unauthorized." } };
    const result = await postBundleEnvelope(url, "/bundles/ingest", "wrong-token", {});
    expect(result).toEqual({ status: 401, body: { error: "Unauthorized." } });
  });

  it("body is undefined (not a throw) when the response has no JSON body", async () => {
    const url = await startFakeServer();
    nextResponse = { status: 204, body: undefined };
    const result = await postBundleEnvelope(url, "/bundles/ingest", undefined, {});
    expect(result.status).toBe(204);
    expect(result.body).toBeUndefined();
  });

  it("a genuine network failure (unreachable host) propagates as a thrown error, not a swallowed result", async () => {
    // Port 1 is a well-known unreachable/reserved port in test environments.
    await expect(postBundleEnvelope("http://localhost:1", "/bundles/ingest", undefined, {})).rejects.toThrow();
  });
});
