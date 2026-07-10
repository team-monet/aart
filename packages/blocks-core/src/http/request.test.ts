import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpClientError, HttpServerError, TimeoutError } from "@aart/types";
import { httpRequestBlock } from "./request.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { EgressDeniedError, setEgressPolicy } from "../lib/egress.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain", "x-custom": "yes" });
      res.end("hello");
      return;
    }
    if (req.url === "/not-found") {
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
    if (req.url === "/echo-body" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
      });
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

describe("http.request", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(httpRequestBlock.manifest.id).toBe("http.request");
    expect(httpRequestBlock.manifest.capabilities).toEqual(["http"]);
  });

  it("returns status/headers/body for a successful response", async () => {
    const result = await httpRequestBlock.execute({ url: `${baseUrl}/ok` }, fakeExecutionContext());
    expect(result).toMatchObject({ status: 200, body: "hello" });
    expect((result as { headers: Record<string, string> }).headers["x-custom"]).toBe("yes");
  });

  it("sends the request method and body through", async () => {
    const result = await httpRequestBlock.execute(
      { url: `${baseUrl}/echo-body`, method: "POST", body: "payload-123" },
      fakeExecutionContext(),
    );
    expect(result).toMatchObject({ status: 200, body: "payload-123" });
  });

  it("throws HttpClientError for a 4xx response", async () => {
    await expect(httpRequestBlock.execute({ url: `${baseUrl}/not-found` }, fakeExecutionContext())).rejects.toThrow(HttpClientError);
  });

  it("throws HttpServerError for a 5xx response", async () => {
    await expect(httpRequestBlock.execute({ url: `${baseUrl}/boom` }, fakeExecutionContext())).rejects.toThrow(HttpServerError);
  });

  it("throws TimeoutError when the response exceeds timeoutMs", async () => {
    await expect(
      httpRequestBlock.execute({ url: `${baseUrl}/slow`, timeoutMs: 200 }, fakeExecutionContext()),
    ).rejects.toThrow(TimeoutError);
  });

  it("rejects a request to a domain outside a configured egress allowlist", async () => {
    setEgressPolicy({ allowedDomains: ["some-other-host.example.com"] });
    await expect(httpRequestBlock.execute({ url: `${baseUrl}/ok` }, fakeExecutionContext())).rejects.toThrow(EgressDeniedError);
  });

  it("allows the request when the host is in the configured egress allowlist", async () => {
    setEgressPolicy({ allowedDomains: ["127.0.0.1"] });
    const result = await httpRequestBlock.execute({ url: `${baseUrl}/ok` }, fakeExecutionContext());
    expect(result).toMatchObject({ status: 200 });
  });
});
