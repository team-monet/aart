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
      if (ok) return { handler: route.handler, params };
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
    const rawBody = await readBody(req);
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
