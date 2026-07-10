// http.request — spec §15.3 HTTP group. The other egress-allowlist
// chokepoint alongside browser.goto/web.read/http.download (architecture
// §4.6 boundary note / ADR-09).
//
// Non-2xx handling is deliberate, not an oversight: a 4xx/5xx response
// THROWS (HttpClientError/HttpServerError, both S0-frozen in
// packages/types/src/errors.ts), it isn't returned as a normal
// `{status: 500, ...}` output. This is what makes `RetryPolicy.retryOn:
// ["5xx"]` (architecture micro-decision #9) actually able to see and
// retry an HTTP failure once S1's engine wires retry matching against
// `errorClass` — a step whose block silently RETURNS a bad status instead
// of throwing would look "completed" to the retry machinery, never
// "failed", and would never be retried no matter what `retryOn` says.
// A connection-level failure (DNS/refused/timeout) never got a response
// at all, so it isn't reshaped into HttpClientError/HttpServerError
// (both documented as "from an external call", i.e. a response WAS
// received) — a timeout becomes `TimeoutError` (also matches
// RetryPolicy.retryOn's `"timeout"` case); anything else propagates as
// the raw fetch failure.
import { z } from "zod";
import { HttpClientError, HttpServerError, TimeoutError } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";
import { checkEgressAllowed } from "../lib/egress.js";

const inputSchema = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe('Defaults to "GET".'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional().describe("Raw request body (already serialized, e.g. via data.stringify for JSON)."),
  timeoutMs: z.number().optional().describe("Defaults to 30000ms."),
});
const outputSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

const DEFAULT_TIMEOUT_MS = 30_000;

export const httpRequestBlock = defineBlock({
  id: "http.request",
  capabilities: ["http"],
  category: "http",
  description:
    'Makes an HTTP request and returns its response. Example: url: "https://api.github.com/repos/x/y", method: "GET". A 4xx/5xx response fails the step (HttpClientError/HttpServerError) rather than being returned silently.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    checkEgressAllowed(input.url);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let response: Response;
    try {
      response = await fetch(input.url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new TimeoutError({ message: `http.request timed out after ${timeoutMs}ms calling ${input.url}`, detail: { kind: "step", url: input.url, timeoutMs }, cause });
      }
      throw cause;
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await response.text();

    if (response.status >= 500) {
      throw new HttpServerError({
        message: `http.request received ${response.status} from ${input.url}`,
        detail: { status: response.status, url: input.url, body },
      });
    }
    if (response.status >= 400) {
      throw new HttpClientError({
        message: `http.request received ${response.status} from ${input.url}`,
        detail: { status: response.status, url: input.url, body },
      });
    }

    return { status: response.status, headers, body };
  },
});
