import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { httpHealthCheckBlock } from "./health-check.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { EgressDeniedError, setEgressPolicy } from "../lib/egress.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("healthy");
      return;
    }
    if (req.url === "/boom") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server exploded");
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("eventually");
      }, 2000);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(() => {
  setEgressPolicy({});
});

describe("http.health_check", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(httpHealthCheckBlock.manifest.id).toBe("http.health_check");
    expect(httpHealthCheckBlock.manifest.capabilities).toEqual(["http"]);
    expect(httpHealthCheckBlock.manifest.category).toBe("http");
  });

  it("reports healthy for a 200 response", async () => {
    const result = await httpHealthCheckBlock.execute({ url: `${baseUrl}/ok` }, fakeExecutionContext());
    expect(result).toMatchObject({ healthy: true, status: 200 });
  });

  it("reports unhealthy for a 500 response when no expectedStatus is given", async () => {
    const result = await httpHealthCheckBlock.execute({ url: `${baseUrl}/boom` }, fakeExecutionContext());
    expect(result).toMatchObject({ healthy: false, status: 500 });
  });

  it("reports healthy for a 500 response when expectedStatus is 500", async () => {
    const result = await httpHealthCheckBlock.execute({ url: `${baseUrl}/boom`, expectedStatus: 500 }, fakeExecutionContext());
    expect(result).toMatchObject({ healthy: true, status: 500 });
  });

  it("reports unhealthy without throwing when the connection fails", async () => {
    const closedServer = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
    const address = closedServer.address();
    if (address === null || typeof address === "string") throw new Error("failed to bind test server");
    const closedPort = address.port;
    await new Promise<void>((resolve, reject) => closedServer.close((err) => (err ? reject(err) : resolve())));

    const result = await httpHealthCheckBlock.execute({ url: `http://127.0.0.1:${closedPort}` }, fakeExecutionContext());
    expect(result).toEqual({ healthy: false, status: null, latencyMs: expect.any(Number) });
  });

  it("reports unhealthy without throwing when the request times out", async () => {
    const result = await httpHealthCheckBlock.execute({ url: `${baseUrl}/slow`, timeoutMs: 200 }, fakeExecutionContext());
    expect(result).toMatchObject({ healthy: false, status: null });
  });

  it("still throws EgressDeniedError for a disallowed domain", async () => {
    setEgressPolicy({ allowedDomains: ["some-other-host.example.com"] });
    await expect(httpHealthCheckBlock.execute({ url: `${baseUrl}/ok` }, fakeExecutionContext())).rejects.toThrow(EgressDeniedError);
  });
});
