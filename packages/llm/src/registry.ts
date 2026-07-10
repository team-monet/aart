// Prompt & schema registry runtime — architecture §12.2, spec §22.2.
// "prompts.<name> and schemas.<name> references resolve against a
// versioned, content-hashed registry, stored alongside workflows rather
// than inlined into them... The specific version resolved for a given run
// is pinned into that run's ExecutionSnapshot... resolution happens once
// per run at the point the llm.* step first executes (not pre-resolved at
// run start)."
import type { AartStore } from "@aart/store";
import type { PromptRegistryEntry, SchemaRegistryEntry } from "@aart/types";
import { createHash } from "node:crypto";
import { InvalidRegistryRefError, RegistryVersionImmutableError, UnresolvedRegistryRefError } from "./errors.js";

// Stable-key-order JSON canonicalization — same technique as
// @aart/registry's hash.ts (packages/registry/src/hash.ts), deliberately
// re-implemented locally rather than imported: architecture frames the pack
// registry and the LLM pack as "two genuinely distinct subsystems... share
// almost no code" (implementation plan S7 note), and this ~15-line pure
// function is cheap enough to duplicate rather than introduce a
// cross-package dependency between two otherwise-unrelated packages for it.
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
    return sorted;
  }
  return value;
}

export function computeContentHash(content: unknown): string {
  const payload = typeof content === "string" ? content : canonicalize(content);
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

const PROMPT_REF_PREFIX = "prompts.";
const SCHEMA_REF_PREFIX = "schemas.";

function stripRefPrefix(ref: string, prefix: string): string {
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    throw new InvalidRegistryRefError({
      message: `"${ref}" is not a valid registry reference — expected the form "${prefix}<name>" (architecture §12.2/spec §22.2)`,
      detail: { ref, expectedPrefix: prefix },
    });
  }
  return ref.slice(prefix.length);
}

// Loose semver-first comparator for "pick the latest version" — falls back
// to lexicographic ordering for non-semver version strings so this doesn't
// throw on a version scheme the registry doesn't mandate (neither source
// document requires versions to be semver; @aart/registry's PackManifest
// versions happen to look like semver in every example, but nothing pins
// that as a hard requirement here either).
function parseSemverLoose(version: string): readonly [number, number, number] | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersions(a: string, b: string): number {
  const pa = parseSemverLoose(a);
  const pb = parseSemverLoose(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      const diff = pa[i]! - pb[i]!;
      if (diff !== 0) return diff;
    }
    return 0;
  }
  return a.localeCompare(b);
}
function pickLatestVersion(versions: readonly string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions).at(-1);
}

// ---------------------------------------------------------------------------
// Registration — authoring-time (or import-time) writes into the registry.
// ---------------------------------------------------------------------------

export async function registerPrompt(store: AartStore, name: string, version: string, body: string): Promise<PromptRegistryEntry> {
  const contentHash = computeContentHash(body);
  const existing = await store.promptRegistry.get(name, version);
  if (existing) {
    if (existing.contentHash !== contentHash) {
      throw new RegistryVersionImmutableError({
        message: `prompt "${name}" version "${version}" already exists with different content — registry versions are immutable once published; publish a new version instead`,
        detail: { name, version, existingContentHash: existing.contentHash, attemptedContentHash: contentHash },
      });
    }
    return existing; // idempotent no-op re-registration of identical content
  }
  const entry: PromptRegistryEntry = { name, version, contentHash, body };
  await store.promptRegistry.put(entry);
  return entry;
}

export async function registerSchema(store: AartStore, name: string, version: string, jsonSchema: Record<string, unknown>): Promise<SchemaRegistryEntry> {
  const contentHash = computeContentHash(jsonSchema);
  const existing = await store.schemaRegistry.get(name, version);
  if (existing) {
    if (existing.contentHash !== contentHash) {
      throw new RegistryVersionImmutableError({
        message: `schema "${name}" version "${version}" already exists with different content — registry versions are immutable once published; publish a new version instead`,
        detail: { name, version, existingContentHash: existing.contentHash, attemptedContentHash: contentHash },
      });
    }
    return existing;
  }
  const entry: SchemaRegistryEntry = { name, version, contentHash, jsonSchema };
  await store.schemaRegistry.put(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Resolution — LAZY, execution-time reads (architecture §12.2's own
// `[DECISION]`: "resolution happens once per run at the point the llm.*
// step first executes... not pre-resolved at run start"). Every caller in
// this package (blocks/*.ts) calls these from INSIDE a block's `execute()`
// — never at workflow-parse or run-start time — which is what makes
// laziness true in practice; see registry.test.ts's "laziness" suite for
// the exact test.
// ---------------------------------------------------------------------------

export interface PromptResolution {
  /** The ref exactly as written in the workflow (e.g. "prompts.energy_bill_extraction"), or "inline" for a step that used `prompt:` directly with no `promptRef:`. */
  ref: string;
  name: string;
  version: string;
  contentHash: string;
  body: string;
}

export interface SchemaResolution {
  ref: string;
  name: string;
  version: string;
  contentHash: string;
  jsonSchema: unknown;
}

export async function resolvePromptRef(store: AartStore, ref: string): Promise<PromptResolution> {
  const name = stripRefPrefix(ref, PROMPT_REF_PREFIX);
  const versions = await store.promptRegistry.listVersions(name);
  const latest = pickLatestVersion(versions);
  if (!latest) {
    throw new UnresolvedRegistryRefError({ message: `"${ref}" has no registered versions`, detail: { ref, name } });
  }
  const entry = await store.promptRegistry.get(name, latest);
  if (!entry) {
    throw new UnresolvedRegistryRefError({ message: `"${ref}" resolved to version "${latest}" via listVersions, but that version could not be read back`, detail: { ref, name, version: latest } });
  }
  return { ref, name: entry.name, version: entry.version, contentHash: entry.contentHash, body: entry.body };
}

export async function resolveSchemaRef(store: AartStore, ref: string): Promise<SchemaResolution> {
  const name = stripRefPrefix(ref, SCHEMA_REF_PREFIX);
  const versions = await store.schemaRegistry.listVersions(name);
  const latest = pickLatestVersion(versions);
  if (!latest) {
    throw new UnresolvedRegistryRefError({ message: `"${ref}" has no registered versions`, detail: { ref, name } });
  }
  const entry = await store.schemaRegistry.get(name, latest);
  if (!entry) {
    throw new UnresolvedRegistryRefError({ message: `"${ref}" resolved to version "${latest}" via listVersions, but that version could not be read back`, detail: { ref, name, version: latest } });
  }
  return { ref, name: entry.name, version: entry.version, contentHash: entry.contentHash, jsonSchema: entry.jsonSchema };
}

/** Synthesizes a `PromptResolution` for an inline `prompt:` (no `promptRef:`) — `version` is the content hash itself (deterministic, reproducible) since there's no registry entry to version it against. See SEAMS.md L1/L3. */
export function inlinePromptResolution(promptText: string): PromptResolution {
  const contentHash = computeContentHash(promptText);
  return { ref: "inline", name: "inline", version: contentHash, contentHash, body: promptText };
}

/** Synthesizes a `SchemaResolution` for an inline `outputSchema` object (not a `schemas.<name>` ref). */
export function inlineSchemaResolution(jsonSchema: unknown): SchemaResolution {
  const contentHash = computeContentHash(jsonSchema);
  return { ref: "inline", name: "inline", version: contentHash, contentHash, jsonSchema };
}

export function isRegistryRef(value: string): "prompt" | "schema" | false {
  if (value.startsWith(PROMPT_REF_PREFIX)) return "prompt";
  if (value.startsWith(SCHEMA_REF_PREFIX)) return "schema";
  return false;
}

// ---------------------------------------------------------------------------
// ExecutionSnapshot.resolvedVersions encoding — architecture §4.5/§12.2:
// "the resolved (name, version, contentHash) TRIPLE is what gets pinned
// into ExecutionSnapshot.resolvedVersions". That field's frozen shape
// (@aart/types run.ts) is `Record<string, string>` — one string value per
// key — which can't literally hold a 3-tuple, so this is the encoding
// convention this package publishes for S1 to consume (SEAMS.md L1):
// key = ref as written, value = "<version>+<contentHash>". contentHash is
// always formatted "sha256:<hex>" (never contains "+"), so splitting on the
// LAST "+" unambiguously recovers `version` even if a semver build-metadata
// suffix in `version` itself contains a "+".
// ---------------------------------------------------------------------------

export function encodeResolvedVersion(resolution: Pick<PromptResolution | SchemaResolution, "version" | "contentHash">): string {
  return `${resolution.version}+${resolution.contentHash}`;
}

export function decodeResolvedVersion(value: string): { version: string; contentHash: string } {
  const idx = value.lastIndexOf("+");
  if (idx < 0) {
    throw new InvalidRegistryRefError({ message: `"${value}" is not a valid encoded resolvedVersions value — expected "<version>+<contentHash>"`, detail: { value } });
  }
  return { version: value.slice(0, idx), contentHash: value.slice(idx + 1) };
}
