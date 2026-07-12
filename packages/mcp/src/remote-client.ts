// fetchFromRemote — the shared HTTP-over-a-configured-remote seam. D2b
// "remote reads" (AMENDMENTS.md, this session) generalizes the inline authed
// fetch `deployToRemoteHandler` (handlers/deployment.ts, D1 "remotes + push,"
// AMENDMENTS.md A56/A57) already built into a small, reusable function — the
// four new `aart_remote_*` READ tools (handlers/remote-observability.ts) need
// the identical "attach a resolved bearer token, GET or POST, parse JSON,
// never throw on a network failure" shape `deployToRemoteHandler` already
// proved out, and a SECOND, independently-drifting copy of that shape for
// reads would be exactly the kind of duplication this codebase's own
// three-clients principle exists to avoid elsewhere.
//
// A plain exported function, NOT a ctx port (unlike EnginePort/GovernancePort/
// etc., types.ts) — there is no stub-vs-real split to make here (a real HTTP
// fetch has nothing to simulate/stub the way a real browser launch or LLM
// call does), matching this file's own sibling `cleartextTokenWarning`
// precedent (handlers/deployment.ts): a small, pure, directly-exported
// shared function, not a DI seam.
import type { RemoteEntry } from "./types.js";

export interface FetchFromRemoteOptions {
  method?: string;
  body?: unknown;
  /**
   * Resolved via `ctx.remotes.resolveToken(name)` by the CALLER — this
   * function has no `ctx`/remote-NAME concept of its own, only the
   * already-resolved `RemoteEntry` + token value. Attached on EVERY call
   * this function makes (GET and POST alike) when given — harmless against
   * a remote whose routes are still open (no `AART_DEPLOY_TOKEN` configured
   * there, `requireDeployTokenIfConfigured`'s own conditional semantics,
   * `@aart/server`'s http/server.ts), and is what lets the four new READ
   * tools (remote-observability.ts) keep working once D2b's own `/runs`+
   * `/runs/:id` read-gating (server.ts, this session) is configured on the
   * far end — the SAME token this function already sends for `aart push`/
   * `aart_deploy`, now forward-compatible with a second gated surface
   * without those four tools needing to know that gate exists at all.
   */
  token?: string;
}

export interface FetchFromRemoteResult {
  /** The real HTTP response's own `.ok` (2xx) — `false` for both a non-2xx HTTP response AND (see `networkError` below) a request that never got a response at all; check `networkError` first to tell the two apart. */
  ok: boolean;
  /** The real HTTP status code — `undefined` only when `networkError` is set (the request never reached the remote at all, so there is no status to report). */
  status?: number;
  /** The parsed JSON response body — `undefined` if the response had no body, or a non-JSON body (mirrors `deployToRemoteHandler`'s own pre-existing "never throw on a malformed response body" tolerance). */
  body: unknown;
  /** Set only when `fetch` itself threw (DNS failure, connection refused, timeout, ...) — the request never reached the remote, so `ok`/`status`/`body` above carry no real HTTP information at all. `undefined` on every response that DID reach the remote, success or failure alike. */
  networkError?: string;
}

/**
 * Mirrors `deployToRemoteHandler`'s own pre-existing inline fetch shape
 * (handlers/deployment.ts, D1 fix pass AMENDMENTS.md A57) byte-for-byte for
 * every call site that migrates onto this function: same header
 * construction (`content-type` only when a body is actually being sent,
 * `authorization: Bearer <token>` only when a token is given), same "parse
 * JSON, tolerate a malformed/absent body" tolerance, same "never throw — a
 * network failure is a returned result, not a rejected promise" discipline,
 * so every caller can rely on that without its own try/catch around `fetch`
 * itself.
 */
export async function fetchFromRemote(remoteEntry: RemoteEntry, path: string, options: FetchFromRemoteOptions = {}): Promise<FetchFromRemoteResult> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(new URL(path, remoteEntry.url), {
      method,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    return { ok: false, body: undefined, networkError: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  return { ok: response.ok, status: response.status, body };
}

/** Shared with `deployment.ts` (moved here so it isn't duplicated across every file that needs to narrow a parsed JSON response body before reading a field off it). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The exact "could not reach remote" wording `deployToRemoteHandler`
 * established (D1 fix pass, AMENDMENTS.md A57) — shared here so it can
 * never independently drift between the push path and the four new
 * read-only `aart_remote_*` tools (remote-observability.ts), all of which
 * can hit this same failure mode (a configured remote whose URL is simply
 * unreachable right now).
 */
export function describeUnreachableRemote(remoteName: string, remoteEntry: RemoteEntry, networkError: string): string {
  return `Could not reach remote "${remoteName}" (${remoteEntry.url}): ${networkError}. Check the URL ("aart remote list") and your network connection, then retry.`;
}

/** A response body's own `{error: string}` shape, when present — the SAME extraction `deployToRemoteHandler`'s refusal branch already performed inline (D1, AMENDMENTS.md A56), generalized so every `aart_remote_*` caller surfaces a remote's real error message instead of a bare status code wherever the remote provides one. */
export function remoteErrorMessage(body: unknown, status: number | undefined): string {
  // `return body["error"]` deliberately on its own line, not folded onto the
  // `if` above — this is the one branch of this function that returns
  // REMOTE-SUPPLIED content rather than a fixed local string, so it gets its
  // own line for the redaction lint (packages/governance/src/redaction-
  // lint.ts) to see and flag on its own, reviewed individually (see this
  // repo-relative file's own redaction-lint-suppressions.ts entry) rather
  // than accidentally escaping detection by sharing a line with its guard.
  if (isRecord(body) && typeof body["error"] === "string") {
    return body["error"];
  }
  return `HTTP ${status ?? "unknown"}`;
}

/** `deployToRemoteHandler`'s own pre-existing "no such remote" remedy (D1, AMENDMENTS.md A56), verbatim — shared here (D2b, this session) so the four new `aart_remote_*` read tools give a caller the exact same, already-proven-clear remedy instead of a differently-worded one for the identical situation. */
export function remoteNotFoundError(remoteName: string): string {
  return `Remote "${remoteName}" not found. Add it first — "aart remote add ${remoteName} <url> --environment <envName>", then "aart remote list" to confirm.`;
}
