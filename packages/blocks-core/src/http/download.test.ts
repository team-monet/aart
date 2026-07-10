import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpClientError, HttpServerError, TimeoutError } from "@aart/types";
import { httpDownloadBlock } from "./download.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { EgressDeniedError, setEgressPolicy } from "../lib/egress.js";

let server: Server;
let baseUrl: string;

const PAYLOAD = Buffer.from([0, 1, 2, 3, 4, 250, 251, 252]);

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/payload.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("root response");
      return;
    }
    if (req.url === "/charset.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("with charset");
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
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

describe("http.download", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(httpDownloadBlock.manifest.id).toBe("http.download");
    expect(httpDownloadBlock.manifest.capabilities).toEqual(["http", "file.write"]);
    expect(httpDownloadBlock.manifest.category).toBe("http");
  });

  it("downloads a byte payload and writes it as an artifact", async () => {
    const ctx = fakeExecutionContext();
    const result = (await httpDownloadBlock.execute({ url: `${baseUrl}/payload.bin` }, ctx)) as { id: string; path: string; bytes: number };
    expect(result.bytes).toBe(PAYLOAD.length);
    expect(result.id).toMatch(/^artifact-fake-\d+$/);
    expect(result.path).toContain("payload.bin");
    expect(ctx.writtenArtifacts).toHaveLength(1);
    const written = ctx.writtenArtifacts[0]!;
    expect(written.name).toBe("payload.bin");
    expect(written.kind).toBe("download");
    expect(written.mime).toBe("application/octet-stream");
    expect(Buffer.compare(Buffer.from(written.bytes), PAYLOAD)).toBe(0);
  });

  it("strips a ; charset=... suffix from content-type before storing it as the artifact's mime", async () => {
    const ctx = fakeExecutionContext();
    await httpDownloadBlock.execute({ url: `${baseUrl}/charset.txt` }, ctx);
    expect(ctx.writtenArtifacts[0]!.mime).toBe("text/plain");
  });

  it("falls back to a generic artifact name when the URL has no path segment", async () => {
    const ctx = fakeExecutionContext();
    await httpDownloadBlock.execute({ url: baseUrl }, ctx);
    expect(ctx.writtenArtifacts[0]!.name).toBe("download");
  });

  it("throws HttpClientError for a 4xx response", async () => {
    await expect(httpDownloadBlock.execute({ url: `${baseUrl}/missing` }, fakeExecutionContext())).rejects.toThrow(HttpClientError);
  });

  it("throws HttpServerError for a 5xx response", async () => {
    await expect(httpDownloadBlock.execute({ url: `${baseUrl}/boom` }, fakeExecutionContext())).rejects.toThrow(HttpServerError);
  });

  it("throws TimeoutError when the response exceeds timeoutMs", async () => {
    await expect(
      httpDownloadBlock.execute({ url: `${baseUrl}/slow`, timeoutMs: 200 }, fakeExecutionContext()),
    ).rejects.toThrow(TimeoutError);
  });

  it("rejects a request to a domain outside a configured egress allowlist", async () => {
    setEgressPolicy({ allowedDomains: ["some-other-host.example.com"] });
    await expect(httpDownloadBlock.execute({ url: `${baseUrl}/payload.bin` }, fakeExecutionContext())).rejects.toThrow(EgressDeniedError);
  });
});
