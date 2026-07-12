// A tiny hand-rolled router on top of node:http — no framework dependency
// (consistent with this package's node:sqlite/node:http choices elsewhere:
// minimal footprint over a third-party dependency where the built-in
// surface is adequate for what's actually needed here).
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
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
   * doesn't pass this option) — this file's pre-existing UNBOUNDED read is
   * completely unchanged; this is an opt-in per-route cap, not a global
   * behavior change. See `BodyTooLargeError`/`readBody` below.
   */
  maxBodyBytes?: number;
}

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
  maxBodyBytes: number | undefined;
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
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler, maxBodyBytes: options?.maxBodyBytes });
  }
  get(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add("GET", path, handler, options);
  }
  post(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add("POST", path, handler, options);
  }

  private match(method: string, segments: string[]): { handler: RouteHandler; params: Record<string, string>; maxBodyBytes: number | undefined } | undefined {
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
      if (ok) return { handler: route.handler, params, maxBodyBytes: route.maxBodyBytes };
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
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, matched.maxBodyBytes);
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
      await matched.handler({ req, res, params: matched.params, query: url.searchParams }, body, rawBody);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
      }
    }
  }
}

/**
 * `maxBytes` omitted (every route except the size-capped ones D1 adds) —
 * behavior is BYTE-IDENTICAL to before this parameter existed: unbounded
 * accumulation, no `Content-Length` check. `maxBytes` given: a `Content-
 * Length` pre-check rejects immediately (no body bytes ever pushed onto
 * this function's own buffer) when the header is present and already over
 * the limit; a running-total check during accumulation catches a client
 * that lies about, omits, or uses chunked transfer-encoding for (which has
 * no `Content-Length` header at all) the body size — once the limit is
 * crossed, further chunks are discarded (never pushed) rather than
 * accumulated, so an oversized upload is never fully buffered into this
 * process's memory.
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
