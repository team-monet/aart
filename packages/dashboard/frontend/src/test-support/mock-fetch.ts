// mockFetchJson — a minimal global.fetch stand-in for page tests: every
// page calls plain fetch("/api/...") and only ever reads `.ok`/`.json()`
// off the result (verified across every page in src/pages/ before writing
// this), so a real Response/undici object is unnecessary — a plain object
// shaped like what the pages actually consume is simpler and has no
// dependency on jsdom's (nonexistent) fetch implementation.
import { vi } from "vitest";

/** `routes` maps a URL substring to the JSON body that should be returned
 * for any request URL containing it. First match wins — order entries from
 * most to least specific if one route's key is a substring of another's
 * (e.g. "/api/workflows/wf-1" before "/api/workflows"). */
export function mockFetchJson(routes: Record<string, unknown>): typeof fetch {
  const mock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    const match = Object.entries(routes).find(([key]) => url.includes(key));
    if (!match) {
      return { ok: false, status: 404, json: async () => ({ error: `no mock route for ${url}` }) };
    }
    return { ok: true, status: 200, json: async () => match[1] };
  });
  return mock as unknown as typeof fetch;
}
