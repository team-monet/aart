// StubBundlerPort / RemotesPort — D1 "remotes + push" (AMENDMENTS.md A56).
// Structural stub-vs-real pairing (this package's established
// GovernancePort/EvidencePort convention — context.ts's own module doc
// comment) for two ports with no prior sibling-package "real"
// implementation to mirror, since there is no separate @aart/remotes
// package — @aart/server itself owns the real produceBundle these bridge to
// (real-context.ts).
//
// createStubBundlerPort: a genuine simplification, mirroring @aart/cli's
// StubServerPort.produceBundle EXACTLY (packages/cli/src/stubs/server.ts) —
// a minimal, structurally-correct bundle (manifest + the ONE workflow
// definition + empty triggers), not the real transitive-closure walk
// (@aart/server's real produceBundle) — sufficient to exercise
// aart_deploy's/aart push's wiring end-to-end without this package's own
// real-context catalog/engine construction.
//
// createRemotesPort (exported under BOTH `createStubRemotesPort`, this
// file, and `createRealRemotesPort`, real-context.ts): genuinely NOT a
// simplification. Reading `<root>/remotes.json` and resolving a secret ref
// (`AART_SECRET_<NAME>` env, then `<root>/secrets.json` fallback — the
// EXACT convention `@aart/cli`'s `createRealSecretResolver`, secrets.ts,
// already established) has no expensive/non-deterministic "real thing" to
// fake, unlike a real browser launch or a real LLM call (what this
// package's OTHER stubs exist specifically to avoid — context.ts's own doc
// comment). One real implementation, exposed under both names for
// structural consistency with this package's established pairing
// convention — not two independently-maintained copies of a fake. Cannot
// import `@aart/cli`'s own `remote-config.ts`/`secrets.ts` here (the
// dependency runs the other way — `@aart/cli` depends on `@aart/mcp`, never
// the reverse), hence the small, deliberate, dependency-free
// (`node:fs`/`node:path` only) duplication of that established convention.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AartStore } from "@aart/store";
import type { BundleLike, BundlerPort, RemoteEntry, RemotesPort } from "../types.js";

export function createStubBundlerPort(store: AartStore): BundlerPort {
  return {
    async produceBundle(params): Promise<BundleLike> {
      const workflow = await store.workflows.get(params.workflowId, params.workflowVersion);
      if (!workflow) throw new Error(`produceBundle: workflow ${params.workflowId}@${params.workflowVersion} not found`);
      const manifest: Record<string, unknown> = {
        workflowId: params.workflowId,
        workflowVersion: params.workflowVersion,
        ...(params.environment ? { targetEnvironment: params.environment } : {}),
        createdAt: new Date().toISOString(),
      };
      const files: Record<string, string> = {
        "manifest.json": JSON.stringify(manifest, null, 2),
        "definitions/workflow.json": JSON.stringify(workflow, null, 2),
        "triggers.json": JSON.stringify({}, null, 2),
      };
      return { manifest, files };
    },
  };
}

function remotesFilePath(root: string): string {
  return join(root, "remotes.json");
}

/** Same "missing/malformed -> {}, never throw" discipline as `@aart/cli`'s `remote-config.ts` `readRemotes` (which this mirrors — see this module's own doc comment for why it isn't imported directly). */
async function readRemotesFile(root: string): Promise<Record<string, RemoteEntry>> {
  try {
    const raw = await fs.readFile(remotesFilePath(root), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, RemoteEntry>;
  } catch {
    return {};
  }
}

function secretsFilePath(root: string): string {
  return join(root, "secrets.json");
}

function bareSecretName(ref: string): string {
  return ref.startsWith("secrets.") ? ref.slice("secrets.".length) : ref;
}

/** Mirrors `@aart/cli`'s `createRealSecretResolver` EXACTLY (secrets.ts) — see this module's own doc comment for why this is a deliberate, minimal duplication rather than an import. */
async function resolveTokenRef(root: string, tokenRef: string): Promise<string | undefined> {
  const name = bareSecretName(tokenRef);
  const envValue = process.env[`AART_SECRET_${name}`];
  if (envValue !== undefined && envValue !== "") return envValue;
  try {
    const raw = await fs.readFile(secretsFilePath(root), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fileValue = parsed[name];
    return typeof fileValue === "string" ? fileValue : undefined;
  } catch {
    return undefined;
  }
}

/** The one real implementation — see this module's own doc comment for why it's exported under both `createStubRemotesPort` (this file) and `createRealRemotesPort` (real-context.ts). */
export function createRemotesPort(root: string): RemotesPort {
  return {
    list: () => readRemotesFile(root),
    async get(name) {
      const all = await readRemotesFile(root);
      return all[name];
    },
    async resolveToken(name) {
      const all = await readRemotesFile(root);
      const entry = all[name];
      if (!entry?.tokenRef) return undefined;
      return resolveTokenRef(root, entry.tokenRef);
    },
  };
}

export const createStubRemotesPort = createRemotesPort;
