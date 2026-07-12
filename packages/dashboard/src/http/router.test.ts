import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError, Router, sendJson, redirect } from "./router.js";

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

  // AMENDMENTS.md A58 — the tester's exact repro: promote via the dashboard
  // without a token turned an upstream 401 into an HTML "500 Internal
  // Server Error" page. These four cover the fix's own contract in
  // isolation, independent of any real upstream server (server.test.ts's
  // own new describe block below proves the full real-server-through-
  // dashboard chain).
  describe("/api/* error mapping — preserves upstream status, JSON not HTML (AMENDMENTS.md A58)", () => {
    it("an HttpError thrown by an /api/* handler preserves its real status as JSON, not a generic HTML 500", async () => {
      const router = new Router();
      router.post("/api/workflows/:id/promote", () => {
        throw new HttpError(401, "POST /workflows/wf-1/promote -> 401: missing or invalid deploy token");
      });
      const started = await listen(router);
      server = started.server;

      const res = await fetch(`${started.baseUrl}/api/workflows/wf-1/promote`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "POST /workflows/wf-1/promote -> 401: missing or invalid deploy token" });
    });

    it("a genuinely unexpected error (no HttpError — a plain thrown Error) on an /api/* route still gets 500, but as JSON, not HTML", async () => {
      const router = new Router();
      router.get("/api/boom", () => {
        throw new Error("something genuinely broke");
      });
      const started = await listen(router);
      server = started.server;

      const res = await fetch(`${started.baseUrl}/api/boom`);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "something genuinely broke" });
    });

    it("preserves 403/404/409 identically to 401 — any real upstream status, not a hardcoded allowlist", async () => {
      const router = new Router();
      router.get("/api/forbidden", () => {
        throw new HttpError(403, "forbidden");
      });
      router.get("/api/missing", () => {
        throw new HttpError(404, "not found");
      });
      router.get("/api/conflict", () => {
        throw new HttpError(409, "conflict");
      });
      const started = await listen(router);
      server = started.server;

      const forbidden = await fetch(`${started.baseUrl}/api/forbidden`);
      expect(forbidden.status).toBe(403);
      const missing = await fetch(`${started.baseUrl}/api/missing`);
      expect(missing.status).toBe(404);
      const conflict = await fetch(`${started.baseUrl}/api/conflict`);
      expect(conflict.status).toBe(409);
    });

    it("a non-/api/* route (the static-file/SPA-fallback path) is unaffected — still HTML, matching the pre-existing /boom test above", async () => {
      const router = new Router();
      router.get("/not-api/boom", () => {
        throw new HttpError(401, "should not matter — this path isn't /api/*");
      });
      const started = await listen(router);
      server = started.server;

      const res = await fetch(`${started.baseUrl}/not-api/boom`);
      expect(res.status).toBe(500); // HttpError's own status is NOT consulted outside /api/*
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("should not matter");
    });
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
