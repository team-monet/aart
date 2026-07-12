// A tiny hand-rolled router on top of node:http — no framework dependency
// (consistent with this package's node:sqlite/node:http choices elsewhere:
// minimal footprint over a third-party dependency where the built-in
// surface is adequate for what's actually needed here).
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_MAX_BODY_BYTES } from "../config.js";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /**
   * D2a security hardening, token-derived attribution (AMENDMENTS.md A59) —
   * set by a route's own `auth` closure (below) when the request carried a
   * PROVIDED, MATCHING deploy token — never by this framework-free file
   * itself, which has no idea what "a token" means (see `RouteOptions.auth`'s
   * own doc comment). `undefined` for every unauthenticated-because-
   * unconfigured request (the conditional-gating tier's own "stays open"
   * branch) and for any route with no `auth` option at all — a caller must
   * treat "unset" as "no attribution available," not "definitely anonymous."
   */
  authenticated?: { label: string };
}

export type RouteHandler = (ctx: RouteContext, body: unknown, rawBody: Buffer) => Promise<void> | void;

export interface RouteOptions {
  /**
   * D1 "remotes + push" (AMENDMENTS.md A56) — a hard cap on this route's
   * request body size, in bytes. Enforced two ways: a `Content-Length`
   * pre-check (rejects before reading a single body byte, when the header
   * is present and honest) AND a running-total check while accumulating
   * chunks (catches a client that lies about, or omits, `Content-Length` —
   * chunked transfer-encoding has none at all). Omitted (every route that
   * doesn't pass this option) — D2a security hardening (AMENDMENTS.md A59)
   * changed this file's pre-existing UNBOUNDED read to `DEFAULT_MAX_BODY_
   * BYTES` instead — a per-route cap here still OVERRIDES that default
   * (e.g. the bundle-ingest routes' much larger `MAX_BUNDLE_INGEST_BYTES`),
   * it just no longer means "no cap at all." See `BodyTooLargeError`/
   * `readBody` below.
   */
  maxBodyBytes?: number;
  /**
   * D2a security hardening (AMENDMENTS.md A59) — an optional per-route auth
   * gate, run BEFORE the request body is ever read (before `readBody`,
   * before JSON-parsing) so an unauthenticated caller can never force this
   * process to buffer/parse a body at all. Returns `true` to let the
   * request proceed to the normal body-read + handler dispatch; returns
   * `false` to stop it right here — in that case the closure MUST have
   * already written the rejection response itself (matching this
   * codebase's established `requireDeployToken`-style "writes its own 401,
   * returns a boolean" convention, `@aart/server`'s http/server.ts) —
   * `Router.handle` does nothing further once `auth` returns `false`.
   * Omitted (every route that doesn't pass this option) — open, unchanged
   * behavior, exactly as if this option didn't exist.
   *
   * Deliberately typed as a fully generic `(ctx) => boolean | Promise<
   * boolean>` with ZERO reference to `ServerConfig`/`deploy-token.ts` — this
   * file stays framework-free (no import of this package's own domain/
   * config types); the actual auth POLICY (what a "valid token" means, what
   * `ServerConfig.deployToken` is) lives entirely in server.ts's own
   * closures over `config` (`requireDeployToken`/`requireDeployTokenIfConfigured`),
   * passed in here as plain functions. This mirrors `maxBodyBytes` above,
   * which is likewise just a number this file has no opinion about the
   * SOURCE of.
   */
  auth?: (ctx: RouteContext) => boolean | Promise<boolean>;
}

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
  maxBodyBytes: number | undefined;
  auth: RouteOptions["auth"];
}

/**
 * D2a security hardening (AMENDMENTS.md A59) — one entry per registered
 * route, returned by `Router.getRoutes()` below. Exists so a completeness
 * test can enumerate every registered route from OUTSIDE this file and
 * assert each POST route explicitly declares its auth stance (either a real
 * `auth` closure, or a deliberate, hardcoded allowlist entry for a route
 * that's supposed to stay open) — converting "a future route silently ships
 * open" into a loud CI failure instead of a silent gap. Read-only by
 * construction (a fresh array of plain data on every call, no reference
 * back into this Router's own mutable `routes` array) — nothing a caller
 * does with the returned value can affect real routing.
 */
export interface RegisteredRoute {
  method: string;
  path: string;
  auth: RouteOptions["auth"];
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Thrown by `readBody` when a size-capped route's request body exceeds `limit` bytes — `Router.handle` catches this specifically and responds `413`, distinct from every other body-read failure (a genuine socket error), which keeps propagating exactly as it always has (this class didn't exist before D1; every OTHER route's behavior is unchanged either way — see `RouteOptions.maxBodyBytes`'s own doc comment). */
export class BodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit for this route.`);
  }
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler, maxBodyBytes: options?.maxBodyBytes, auth: options?.auth });
  }
  get(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add("GET", path, handler, options);
  }
  post(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add("POST", path, handler, options);
  }

  /** D2a security hardening (AMENDMENTS.md A59) — read-only route-table accessor; see `RegisteredRoute`'s own doc comment for why this exists. */
  getRoutes(): RegisteredRoute[] {
    return this.routes.map((r) => ({ method: r.method, path: `/${r.segments.join("/")}`, auth: r.auth }));
  }

  private match(method: string, segments: string[]): { handler: RouteHandler; params: Record<string, string>; maxBodyBytes: number | undefined; auth: RouteOptions["auth"] } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== segments.length) {
        // Support a trailing "*" wildcard segment for mount points (e.g. `/dashboard/*`).
        if (route.segments.at(-1) === "*" && segments.length >= route.segments.length - 1) {
          // fallthrough to matching below with wildcard tolerance
        } else {
          continue;
        }
      }
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        if (seg === "*") break;
        if (seg.startsWith(":")) {
          const value = segments[i];
          if (value === undefined) {
            ok = false;
            break;
          }
          params[seg.slice(1)] = decodeURIComponent(value);
          continue;
        }
        if (segments[i] !== seg) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params, maxBodyBytes: route.maxBodyBytes, auth: route.auth };
    }
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = this.match((req.method ?? "GET").toUpperCase(), splitPath(url.pathname));
    if (!matched) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    // D2a security hardening (AMENDMENTS.md A59) — ctx is built HERE, before
    // any body is read, specifically so `auth` (below) can run — and, on
    // success via a provided/matching token, stamp `ctx.authenticated` —
    // before a single body byte is buffered or parsed. RouteContext (above)
    // never carries the body itself (a separate positional handler arg), so
    // building it this early is a pure no-op shape change for every route
    // that doesn't use `auth`.
    const ctx: RouteContext = { req, res, params: matched.params, query: url.searchParams };
    if (matched.auth && !(await matched.auth(ctx))) {
      // The auth closure has already written its own rejection response
      // (matching `RouteOptions.auth`'s own documented contract) — stop
      // here, before `readBody` ever runs, so an unauthenticated caller can
      // never force this process to buffer/parse a request body at all.
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, matched.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: `${err.message} Split the payload into something smaller, or remove unused content, and retry.` });
        return;
      }
      throw err; // every other read failure (a genuine socket error) propagates exactly as it always has — unchanged pre-existing behavior
    }
    let body: unknown;
    try {
      body = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : undefined;
    } catch {
      body = undefined;
    }
    try {
      // Reuses the SAME ctx object `auth` (if any) already ran against — so
      // a `ctx.authenticated` an `auth` closure stamped is visible to the
      // handler, not a second, freshly-built object that would silently
      // drop it.
      await matched.handler(ctx, body, rawBody);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
      }
    }
  }
}

/**
 * This function itself has no opinion on WHAT `maxBytes` is — `Router.handle`
 * (the one caller) always passes a concrete number now (D2a security
 * hardening, AMENDMENTS.md A59: `matched.maxBodyBytes ?? DEFAULT_MAX_BODY_
 * BYTES` — no more truly-unbounded call site since that change; before it,
 * `maxBytes` could be `undefined` here for any route that didn't opt in,
 * and this whole cap was skipped). A `Content-Length` pre-check rejects
 * immediately (no body bytes ever pushed onto this function's own buffer)
 * when the header is present and already over the limit; a running-total
 * check during accumulation catches a client that lies about, omits, or
 * uses chunked transfer-encoding for (which has no `Content-Length` header
 * at all) the body size — once the limit is crossed, further chunks are
 * discarded (never pushed) rather than accumulated, so an oversized upload
 * is never fully buffered into this process's memory. The `maxBytes ===
 * undefined` branch below is kept (rather than making the parameter
 * required) so this function's own dedicated tests, and any future direct
 * caller, can still ask for a genuinely uncapped read.
 *
 * Deliberately does NOT call `req.destroy()` on an over-limit request:
 * `req`/`res` share the same underlying socket, and destroying it here —
 * before `Router.handle`'s `catch` block ever gets a chance to write the
 * `413` response — kills the connection out from under that response,
 * which most HTTP clients (verified against Node's own `fetch`/undici)
 * surface as a raw socket error instead of the intended `413 {error}` JSON
 * body. The stream is left attached (so Node keeps draining/discarding the
 * remaining request bytes in the background, off this function's own
 * buffer) and `Router.handle` writes a normal response on the still-open
 * connection once this promise rejects.
 */
function readBody(req: IncomingMessage, maxBytes?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxBytes !== undefined) {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        reject(new BodyTooLargeError(maxBytes));
        // D1 fix pass (AMENDMENTS.md A57) — a defensive no-op "error"
        // listener, attached BEFORE resume() below: this branch drains via
        // req.resume() with no listener otherwise attached, unlike the
        // accumulation branch below (which always has one). An empirically
        // unhandled "error" event on a stream with zero listeners crashes
        // the process (EventEmitter's own documented default behavior) —
        // reviewed and found no reproducible crash on this codebase's
        // pinned Node (22.22.2), but that's an undocumented-for-this-
        // exact-shape implementation detail, not a contract this code
        // should rely on. One line, removes that reliance either way.
        req.on("error", () => {});
        req.resume(); // drain (and discard) the request body in the background rather than leaving the socket paused with unread bytes
        return;
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (maxBytes !== undefined && total > maxBytes) {
        settled = true;
        reject(new BodyTooLargeError(maxBytes));
        return; // keep the "data" listener attached (see doc comment above) — later chunks hit the `if (settled) return;` guard and are discarded, never destroying the connection
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
