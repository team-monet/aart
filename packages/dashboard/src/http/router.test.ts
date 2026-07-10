import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Router, sendJson, redirect } from "./router.js";

function listen(router: Router): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => void router.handle(req, res));
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("Router", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("matches a :param segment and decodes it", async () => {
    const router = new Router();
    router.get("/runs/:id", (ctx) => sendJson(ctx.res, 200, { id: ctx.params["id"] }));
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/runs/run%20one`);
    expect(await res.json()).toEqual({ id: "run one" });
  });

  it("matches a trailing * wildcard mount point", async () => {
    const router = new Router();
    router.get("/dashboard/*", (ctx) => sendJson(ctx.res, 200, { ok: true }));
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/dashboard/anything/deep`);
    expect(res.status).toBe(200);
  });

  it("parses query string params", async () => {
    const router = new Router();
    router.get("/runs", (ctx) => sendJson(ctx.res, 200, { status: ctx.query.get("status") }));
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/runs?status=failed`);
    expect(await res.json()).toEqual({ status: "failed" });
  });

  it("parses a form-urlencoded POST body", async () => {
    const router = new Router();
    router.post("/corrections", (ctx, body) => sendJson(ctx.res, 200, body));
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "reason=off+by+one&reviewer=alice",
    });
    expect(await res.json()).toEqual({ reason: "off by one", reviewer: "alice" });
  });

  it("parses a JSON POST body", async () => {
    const router = new Router();
    router.post("/corrections", (ctx, body) => sendJson(ctx.res, 200, body));
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "off by one" }),
    });
    expect(await res.json()).toEqual({ reason: "off by one" });
  });

  it("returns 404 html for an unmatched route", async () => {
    const router = new Router();
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("404");
  });

  it("returns 500 html when a handler throws, without leaking the process", async () => {
    const router = new Router();
    router.get("/boom", () => {
      throw new Error("kaboom");
    });
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/boom`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("kaboom");
  });

  it("redirect() sends a 303 with a Location header", async () => {
    const router = new Router();
    router.post("/flagged-runs/:runId/clear", (ctx) => redirect(ctx.res, "/flagged-runs"));
    const started = await listen(router);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/flagged-runs/r1/clear`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/flagged-runs");
  });
});
