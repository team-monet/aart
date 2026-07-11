// The real SecretResolver (AMENDMENTS.md A45) — the piece A44 found missing:
// `real-server-port.ts`'s `startServer` called `@aart/server`'s real
// `startServer` with no `secretResolver` at all, so `binding
// .webhookHmacSecretRef ? await config.secretResolver?.(...) : undefined`
// (packages/server/src/http/server.ts) always resolved to `undefined`
// regardless of what a trigger config named — meaning webhook/github/slack
// HMAC verification could never succeed through a real `aart server`
// (architecture §6.1/§15 makes that verification mandatory, not optional).
//
// Verified before writing this: no `AART_SECRET_*` convention, secrets
// file, or any other concrete `SecretResolver`/`EngineConfig.resolveSecret`
// implementation exists ANYWHERE in this codebase today (`resolveSecret`
// falls back to `throwingSecretResolver` at every real call site, including
// `@aart/mcp`'s own real composition root, `real-context.ts`'s
// `createRealEngine`). `Environment.secretSource` (frozen shape,
// `packages/types/src/store-records.ts`) is a separate, already-real
// concept — an operator-supplied SOURCE/config descriptor ("where does this
// environment's secret come from", e.g. a vault path — see
// `packages/dashboard/src/views/production.ts`'s read-only "secrets status"
// page and `packages/server/src/environments.ts`'s `registerEnvironment`,
// which persists it) — but nothing anywhere actually FETCHES a live value
// FROM a `secretSource` descriptor (no vault client, no fetch-from-path
// implementation exists), and no CLI/MCP command even sets it today. It is
// real but unwired to actual resolution; extending it into a pluggable
// per-environment secret backend is real, separate feature work beyond this
// session's mandate, not attempted here.
//
// So this is a genuinely new implementation, not a rewiring of an existing
// one — built to the one convention this task's own brief specifies
// (`AART_SECRET_*` env, store-adjacent secrets file), since no other real
// convention exists to match instead.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SecretResolver } from "@aart/server";

/** `TriggerBinding.webhookHmacSecretRef`'s documented/stored form is the full `secrets.<NAME>` reference (verified: `packages/server/src/http/server.test.ts`'s own fixtures use `"secrets.WEBHOOK_SECRET"` etc.) — this resolver accepts that form OR a bare `<NAME>` (a caller typing `--webhook-hmac-secret-ref WEBHOOK_SECRET` directly, with no `secrets.` prefix, should still resolve), normalizing both to the bare name before lookup. */
function bareSecretName(ref: string): string {
  return ref.startsWith("secrets.") ? ref.slice("secrets.".length) : ref;
}

/** The on-disk fallback's filename, resolved relative to the store root (`<root>/secrets.json`, sibling to fs-store's own managed subdirectories — see `paths.ts`, no collision) — a flat `{ "<NAME>": "value" }` JSON map. Dev-convenience only: no encryption, no access control beyond the filesystem's own — appropriate for local/dev secret material, not a production secret-management story (documented in TEST-DRIVE.md alongside `--store`/`--root`). */
function secretsFilePath(root: string): string {
  return join(root, "secrets.json");
}

/**
 * The real `SecretResolver` (architecture §3.2/§6.1's injected-resolver
 * discipline) — `AART_SECRET_<NAME>` env var first (the quick, no-file-
 * needed path for a live demo or CI), falling back to `<root>/secrets.json`
 * (a persisted dev convenience — set once, survives across `aart server`
 * restarts without re-exporting an env var each time). Returns `undefined`
 * (never throws) when a ref resolves to neither — `verifyHmacSignature`
 * already treats an `undefined`/empty secret as a failed verification
 * (hmac.ts: `if (!signatureHeader || !secret) return false`), so an
 * unconfigured secret correctly manifests as every delivery for that
 * binding being rejected `bad_hmac`, not a resolver-level crash.
 */
export function createRealSecretResolver(root: string): SecretResolver {
  return async (ref: string): Promise<string | undefined> => {
    const name = bareSecretName(ref);
    const envValue = process.env[`AART_SECRET_${name}`];
    if (envValue !== undefined && envValue !== "") return envValue;
    try {
      const raw = await fs.readFile(secretsFilePath(root), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const fileValue = parsed[name];
      return typeof fileValue === "string" ? fileValue : undefined;
    } catch {
      // No secrets.json (the common case — most dev setups use the env var
      // alone), or it's unreadable/malformed — either way, "no secret
      // configured for this ref" is the correct resolution, not a throw:
      // this resolver runs on every inbound HTTP delivery, and a malformed
      // local file must not turn into a 500 on every webhook POST.
      return undefined;
    }
  };
}
