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

  it("a route with NO maxBodyBytes option is completely unaffected — unbounded read, unchanged pre-D1 behavior", async () => {
    const router = new Router();
    router.post("/uncapped", (ctx, body) => sendJson(ctx.res, 200, { ok: true, received: body }), undefined);
    const p = await startRouter(router);

    const large = "x".repeat(2_000_000); // 2MB — would exceed any reasonable cap, must still succeed here
    const res = await fetch(`http://localhost:${p}/uncapped`, { method: "POST", body: JSON.stringify({ large }) });
    expect(res.status).toBe(200);
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
