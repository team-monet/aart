// http.download — spec §15.3 HTTP group. Like http.request, a non-2xx
// response THROWS (HttpClientError/HttpServerError) rather than being
// returned as data — see request.ts's doc comment for the full retry-
// matching rationale, which applies identically here. Distinct from
// http.request in one respect: this block also writes an artifact, so it
// declares both the "http" and "file.write" capabilities (spec §31.0) even
// though it lives in the http.* namespace rather than file.*. Shares the
// same egress allowlist chokepoint (lib/egress.ts) as http.request,
// browser.goto, and web.read (architecture §4.6 / ADR-09).
import { z } from "zod";
import { HttpClientError, HttpServerError, TimeoutError } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";
import { checkEgressAllowed } from "../lib/egress.js";

const inputSchema = z.object({
  url: z.string(),
  timeoutMs: z.number().optional().describe("Defaults to 30000ms."),
});
const outputSchema = z.object({
  id: z.string(),
  path: z.string(),
  bytes: z.number(),
});

const DEFAULT_TIMEOUT_MS = 30_000;

export const httpDownloadBlock = defineBlock({
  id: "http.download",
  capabilities: ["http", "file.write"],
  category: "http",
  description:
    'Downloads a URL and stores its bytes as an artifact. Example: url: "https://example.com/report.pdf" -> writes the PDF as an artifact and returns { id, path, bytes }.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    checkEgressAllowed(input.url);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let response: Response;
    try {
      response = await fetch(input.url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new TimeoutError({
          message: `http.download timed out after ${timeoutMs}ms calling ${input.url}`,
          detail: { kind: "step", url: input.url, timeoutMs },
          cause,
        });
      }
      throw cause;
    }

    if (response.status >= 500) {
      const body = await response.text();
      throw new HttpServerError({
        message: `http.download received ${response.status} from ${input.url}`,
        detail: { status: response.status, url: input.url, body },
      });
    }
    if (response.status >= 400) {
      const body = await response.text();
      throw new HttpClientError({
        message: `http.download received ${response.status} from ${input.url}`,
        detail: { status: response.status, url: input.url, body },
      });
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // .split(";")[0]: a real content-type header often carries a
    // "; charset=..." suffix (e.g. "text/html; charset=utf-8") — Artifact.mime
    // (spec §13.7) is documented as a bare MIME type, so strip it rather than
    // storing the charset param as part of the mime value.
    const mime = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    const name = new URL(input.url).pathname.split("/").filter(Boolean).pop() ?? "download";
    const written = await ctx.writeArtifact({ name, kind: "download", mime, bytes });
    return { id: written.id, path: written.path, bytes: bytes.length };
  },
});
