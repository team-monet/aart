// http.health_check — spec §15.3 HTTP group. A SENSOR, not an assertion
// (contrast with http.request/http.download, which throw on a bad status):
// a bad status code, a connection failure, or a timeout is all reported as
// `{healthy: false, ...}`, never thrown — a workflow author branches on the
// result instead of the step failing outright. The one exception is
// `checkEgressAllowed` (lib/egress.ts): a domain-policy violation is still
// thrown, since that's a governance failure, not a health signal about the
// target endpoint.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { checkEgressAllowed } from "../lib/egress.js";

const inputSchema = z.object({
  url: z.string(),
  timeoutMs: z.number().optional().describe("Defaults to 10000ms."),
  expectedStatus: z.number().optional().describe('When given, healthy requires an exact status match instead of the default "status < 400" check.'),
});
const outputSchema = z.object({
  healthy: z.boolean(),
  status: z.number().nullable(),
  latencyMs: z.number(),
});

const DEFAULT_TIMEOUT_MS = 10_000;

export const httpHealthCheckBlock = defineBlock({
  id: "http.health_check",
  capabilities: ["http"],
  category: "http",
  description:
    'Checks whether an HTTP endpoint responds, without failing the step on a bad status or connection error. Example: url: "https://api.example.com/healthz" -> { healthy: true, status: 200, latencyMs: 42 }.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    checkEgressAllowed(input.url);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    let response: Response;
    try {
      response = await fetch(input.url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { healthy: false, status: null, latencyMs: Date.now() - start };
    }

    const healthy = input.expectedStatus !== undefined ? response.status === input.expectedStatus : response.status < 400;
    return { healthy, status: response.status, latencyMs: Date.now() - start };
  },
});
