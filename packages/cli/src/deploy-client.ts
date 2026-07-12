// D1 "remotes + push" (AMENDMENTS.md A56) — a thin, standalone fetch-based
// POST helper for the deploy surface (POST /bundles/ingest, POST
// /bundles/plan). Node 22's GLOBAL `fetch` — zero new dependencies; the
// esbuild EXTERNAL list (scripts/build-publish.mjs) needs no change since
// this imports nothing beyond a Node built-in global.
//
// NOT imported by @aart/mcp's `deployToRemoteHandler` (packages/mcp/src/
// handlers/deployment.ts) — that function is the ONE shared implementation
// `aart push`/`aart_deploy` both route through directly (three-clients
// principle: `pushCommand` below calls it exactly the same way
// `deployCommand` calls `deployWorkflowHandler`), and `@aart/mcp` cannot
// depend on `@aart/cli` (the dependency runs the other way) — so that
// handler's own outbound POST is a small, independently-defined mirror of
// this exact shape, the same unavoidable-duplication class as
// `stubs/deploy.ts`'s remotes.json/secrets.json reading (that module's own
// doc comment has the fuller reasoning). This module is CLI's own
// directly-testable, standalone copy of the identical primitive — see
// deploy-client.test.ts for isolated coverage of the POST mechanics
// (headers, body shape, non-JSON/network-failure handling) without needing
// a full AartContext/remotes.json/store fixture.
export interface PostBundleResult {
  status: number;
  body: unknown;
}

/**
 * POSTs `{ files }` to `<remoteUrl><path>` with an optional bearer token.
 * Never throws on a non-2xx response or a non-JSON body — both are
 * legitimate, expected shapes the caller inspects via the returned
 * `status`/`body` (mirroring this codebase's established "resolve, don't
 * throw, for an expected failure mode" discipline — e.g.
 * `createRealSecretResolver`, secrets.ts). DOES let a genuine network
 * failure (unreachable host, DNS failure, ...) propagate as a thrown
 * error — that is not a shape this function can meaningfully turn into a
 * `{status, body}` result, and the caller (`deployToRemoteHandler`'s own
 * mirror, or `pushCommand`) is expected to catch it and surface an
 * actionable "could not reach remote" message.
 */
export async function postBundleEnvelope(remoteUrl: string, path: "/bundles/ingest" | "/bundles/plan", token: string | undefined, files: Record<string, string>): Promise<PostBundleResult> {
  const response = await fetch(new URL(path, remoteUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ files }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}
