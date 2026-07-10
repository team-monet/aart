// A minimal, structurally-typed HTTP response/fetch shape — used by the
// openai.ts/google.ts adapters (raw REST wire format, per-provider) as their
// injection seam. Node 22's global `fetch` (WHATWG) satisfies this
// structurally; tests inject a fully in-memory fake instead (this session's
// DoD: "tested with fake/mocked provider responses — no real API calls
// required").
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponseLike>;

/** The real, production transport — Node 22's built-in global `fetch`. Never exercised by this package's own tests (network calls are explicitly out of this session's scope — see package README/report). */
export const nodeFetcher: Fetcher = (url, init) => fetch(url, init);
