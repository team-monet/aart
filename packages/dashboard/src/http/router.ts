// A tiny hand-rolled router on top of node:http — no framework dependency,
// matching this workspace's repeated convention (@aart/server's own
// packages/server/src/http/router.ts follows the identical shape). Kept
// deliberately small: `:param` segments, a trailing `*` wildcard, GET/POST,
// query-string parsing, and JSON body parsing for POST bodies (this
// package's writable actions are all form-POSTs or JSON-POSTs).
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (ctx: RouteContext, body: Record<string, unknown>) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
  }
  get(path: string, handler: RouteHandler): void {
    this.add("GET", path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.add("POST", path, handler);
  }

  private match(method: string, segments: string[]): { handler: RouteHandler; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== segments.length) {
        const isWildcard = route.segments.at(-1) === "*" && segments.length >= route.segments.length - 1;
        if (!isWildcard) continue;
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
      if (ok) return { handler: route.handler, params };
    }
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = this.match((req.method ?? "GET").toUpperCase(), splitPath(url.pathname));
    if (!matched) {
      sendHtml(res, 404, "<h1>404 Not Found</h1>");
      return;
    }
    const body = await readBody(req);
    try {
      await matched.handler({ req, res, params: matched.params, query: url.searchParams }, body);
    } catch (err) {
      if (!res.headersSent) {
        sendHtml(res, 500, `<h1>500 Internal Server Error</h1><pre>${err instanceof Error ? err.message : "unknown error"}</pre>`);
      }
    }
  }
}

/** Parses a POST body as either `application/json` or `application/x-www-form-urlencoded` (this package's own forms use the latter; JSON is supported for programmatic/CLI-adjacent callers). GET requests have no body — returns `{}`. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(raw);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/** A 303-see-other redirect — the correct status for "POST completed, now GET this page" (avoids the browser re-POSTing on refresh/back, unlike a bare 302). Every writable-action route in this package redirects back to a read view this way after a successful action. */
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}
