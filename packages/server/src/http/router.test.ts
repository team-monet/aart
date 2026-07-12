// Router — dedicated coverage for the D1 "remotes + push" (AMENDMENTS.md
// A56) per-route body-size cap (RouteOptions.maxBodyBytes). Every other
// Router behavior (path matching, params, wildcard mount points, the 404/500
// envelopes) is already exercised indirectly through http/server.test.ts's
// real route registrations; this file is scoped to the one genuinely new
// capability, in isolation, plus the "every uncapped route is byte-for-byte
// unaffected" regression this change must never break.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Router, sendJson } from "./router.js";

let server: Server | undefined;
let port: number | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  port = undefined;
});

async function startRouter(router: Router): Promise<number> {
  server = createServer((req, res) => {
    void router.handle(req, res);
  });
  port = await new Promise<number>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, () => {
      const address = server!.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return port;
}

describe("Router — maxBodyBytes (AMENDMENTS.md A56)", () => {
  it("a body under the cap is accepted normally", async () => {
    const router = new Router();
    router.post("/capped", (ctx, body) => sendJson(ctx.res, 200, { ok: true, received: body }), { maxBodyBytes: 1024 });
    const p = await startRouter(router);

    const res = await fetch(`http://localhost:${p}/capped`, { method: "POST", body: JSON.stringify({ small: "payload" }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, received: { small: "payload" } });
  });

  it("a Content-Length header already over the cap is rejected 413 before any body bytes are read", async () => {
    const router = new Router();
    let handlerCalled = false;
    router.post("/capped", (ctx) => {
      handlerCalled = true;
      sendJson(ctx.res, 200, { ok: true });
    }, { maxBodyBytes: 10 });
    const p = await startRouter(router);

    const oversized = "x".repeat(1000);
    const res = await fetch(`http://localhost:${p}/capped`, { method: "POST", body: oversized });
    expect(res.status).toBe(413);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toMatch(/exceeds the 10-byte limit/i);
    expect(handlerCalled).toBe(false); // the route handler never ran
  });

  it("the 413 error carries an actionable remedy, not just a bare refusal", async () => {
    const router = new Router();
    router.post("/capped", (ctx) => sendJson(ctx.res, 200, { ok: true }), { maxBodyBytes: 5 });
    const p = await startRouter(router);

    const res = await fetch(`http://localhost:${p}/capped`, { method: "POST", body: "way too much content for the cap" });
    expect(res.status).toBe(413);
    const payload = (await res.json()) as { error: string };
    expect(payload.error.length).toBeGreaterThan(0);
    expect(payload.error).toMatch(/split|smaller|remove/i); // names a concrete remedy, not just "too large"
  });

  it("a chunked request with NO Content-Length header, exceeding the cap, is still caught by the running-total check", async () => {
    const router = new Router();
    router.post("/capped", (ctx) => sendJson(ctx.res, 200, { ok: true }), { maxBodyBytes: 20 });
    const p = await startRouter(router);

    // fetch()'s streaming body request omits Content-Length (chunked
    // transfer-encoding) — exercises the accumulation-time check, not the
    // header pre-check above.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(15)));
        controller.enqueue(new TextEncoder().encode("b".repeat(15))); // 30 bytes total, over the 20-byte cap
        controller.close();
      },
    });
    const res = await fetch(`http://localhost:${p}/capped`, { method: "POST", body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(413);
  });

  // D2a security hardening (AMENDMENTS.md A59) — this test used to be titled
  // "...is completely unaffected — unbounded read"; that claim is no longer
  // true (see the two tests immediately below, which prove the opposite for
  // a body over the new default). Recalibrated to a body comfortably under
  // DEFAULT_MAX_BODY_BYTES (1MB) so it still demonstrates what IS still
  // true: a route with no explicit maxBodyBytes behaves normally for an
  // ordinary-sized request.
  it("a route with NO maxBodyBytes option still accepts a normal-sized body", async () => {
    const router = new Router();
    router.post("/uncapped", (ctx, body) => sendJson(ctx.res, 200, { ok: true, received: body }), undefined);
    const p = await startRouter(router);

    const normal = "x".repeat(10_000); // 10KB — well under the 1MB default, must still succeed
    const res = await fetch(`http://localhost:${p}/uncapped`, { method: "POST", body: JSON.stringify({ normal }) });
    expect(res.status).toBe(200);
  });

  // D2a security hardening (AMENDMENTS.md A59) — the OPPOSITE of this
  // file's own former "no maxBodyBytes = unbounded" claim: Router.handle
  // now applies DEFAULT_MAX_BODY_BYTES (1MB) to any route that doesn't pass
  // its own explicit maxBodyBytes, closing the "every route not on the
  // bundle-ingest allowlist could be forced to buffer an arbitrarily large
  // body" gap. A 2MB body — the exact size the old test proved succeeded —
  // now rejects 413.
  it("a route with NO maxBodyBytes option now rejects a body OVER the DEFAULT cap — no longer truly unbounded", async () => {
    const router = new Router();
    let handlerCalled = false;
    router.post(
      "/uncapped-but-not-unbounded",
      (ctx) => {
        handlerCalled = true;
        sendJson(ctx.res, 200, { ok: true });
      },
      undefined,
    );
    const p = await startRouter(router);

    const oversized = "x".repeat(2_000_000); // 2MB — over the 1MB default
    const res = await fetch(`http://localhost:${p}/uncapped-but-not-unbounded`, { method: "POST", body: JSON.stringify({ oversized }) });
    expect(res.status).toBe(413);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toMatch(/exceeds the 1048576-byte limit/i);
    expect(handlerCalled).toBe(false);
  });

  it("one capped route and one uncapped route on the SAME router behave independently", async () => {
    const router = new Router();
    router.post("/capped", (ctx) => sendJson(ctx.res, 200, { ok: true }), { maxBodyBytes: 10 });
    router.post("/uncapped", (ctx) => sendJson(ctx.res, 200, { ok: true }));
    const p = await startRouter(router);

    const cappedRes = await fetch(`http://localhost:${p}/capped`, { method: "POST", body: "x".repeat(1000) });
    expect(cappedRes.status).toBe(413);

    const uncappedRes = await fetch(`http://localhost:${p}/uncapped`, { method: "POST", body: "x".repeat(1000) });
    expect(uncappedRes.status).toBe(200);
  });
});

// D2a security hardening (AMENDMENTS.md A59) — RouteOptions.auth, in
// isolation from any domain-specific policy (that's server.ts's job — see
// http/server.test.ts's own auth-gate suite). This file only proves the
// FRAMEWORK contract: auth runs, auth can stop the request before the
// handler (and before the body is read), auth can let it through, and
// omitting the option changes nothing.
describe("Router — auth option (D2a, AMENDMENTS.md A59)", () => {
  it("auth returning true lets the request proceed to the handler normally", async () => {
    const router = new Router();
    let authCalled = false;
    router.post(
      "/gated",
      (ctx, body) => sendJson(ctx.res, 200, { ok: true, received: body }),
      {
        auth: () => {
          authCalled = true;
          return true;
        },
      },
    );
    const p = await startRouter(router);

    const res = await fetch(`http://localhost:${p}/gated`, { method: "POST", body: JSON.stringify({ x: 1 }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, received: { x: 1 } });
    expect(authCalled).toBe(true);
  });

  it("auth returning false stops the request BEFORE the handler runs — the auth closure's own response is what the client sees, not a router-generated one", async () => {
    const router = new Router();
    let handlerCalled = false;
    router.post(
      "/gated",
      () => {
        handlerCalled = true;
      },
      {
        auth: (ctx) => {
          sendJson(ctx.res, 401, { error: "no." });
          return false;
        },
      },
    );
    const p = await startRouter(router);

    // A malformed (non-JSON) body — if the handler or the router's own
    // body-read/parse path ran, a malformed body wouldn't itself cause a
    // failure (JSON.parse failures fall back to `body: undefined`, per
    // Router.handle's own established behavior) — this is really testing
    // that the 401 comes from `auth`, not from downstream dispatch, via the
    // handlerCalled flag below being the load-bearing assertion.
    const res = await fetch(`http://localhost:${p}/gated`, { method: "POST", body: "not json" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "no." });
    expect(handlerCalled).toBe(false);
  });

  it("auth is awaited when it returns a Promise", async () => {
    const router = new Router();
    router.post("/gated-async", (ctx) => sendJson(ctx.res, 200, { ok: true }), {
      auth: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (ctx.query.get("token") !== "right") {
          sendJson(ctx.res, 401, { error: "wrong token" });
          return false;
        }
        return true;
      },
    });
    const p = await startRouter(router);

    const wrong = await fetch(`http://localhost:${p}/gated-async`, { method: "POST", body: "{}" });
    expect(wrong.status).toBe(401);

    const right = await fetch(`http://localhost:${p}/gated-async?token=right`, { method: "POST", body: "{}" });
    expect(right.status).toBe(200);
  });

  it("omitting auth entirely is open, unchanged behavior — exactly as if the option didn't exist", async () => {
    const router = new Router();
    router.post("/open", (ctx) => sendJson(ctx.res, 200, { ok: true }));
    const p = await startRouter(router);

    const res = await fetch(`http://localhost:${p}/open`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
  });

  it("a successful auth's ctx.authenticated stamp is visible to the handler — the SAME ctx object, not a fresh one", async () => {
    const router = new Router();
    router.post("/attributed", (ctx) => sendJson(ctx.res, 200, { authenticated: ctx.authenticated }), {
      auth: (ctx) => {
        ctx.authenticated = { label: "test-token" };
        return true;
      },
    });
    const p = await startRouter(router);

    const res = await fetch(`http://localhost:${p}/attributed`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: { label: "test-token" } });
  });

  it("getRoutes() enumerates every registered route with its method, path, and auth presence", () => {
    const router = new Router();
    router.get("/health", () => {});
    router.post("/open", () => {});
    router.post("/gated", () => {}, { auth: () => true });
    router.post("/workflows/:id/approve", () => {}, { auth: () => true });

    const routes = router.getRoutes();
    expect(routes).toHaveLength(4);
    expect(routes.find((r) => r.method === "GET" && r.path === "/health")?.auth).toBeUndefined();
    expect(routes.find((r) => r.method === "POST" && r.path === "/open")?.auth).toBeUndefined();
    expect(routes.find((r) => r.method === "POST" && r.path === "/gated")?.auth).toBeDefined();
    expect(routes.find((r) => r.method === "POST" && r.path === "/workflows/:id/approve")?.auth).toBeDefined();
  });
});
