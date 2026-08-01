// Pack content hashing — architecture §11.1: "content hash = SHA-256 over
// the canonicalized (stable key ordering) manifest JSON plus every block's
// implementation source concatenated in a stable order — this is what 'any
// edit breaks approval seal' (§16.2) mechanically checks."
import { createHash } from "node:crypto";

/**
 * Deterministic, stable-key-order JSON serialization. Object keys are
 * sorted recursively so two objects with identical content but differently
 * ordered keys canonicalize to the exact same string — this is the
 * "canonicalized (stable key ordering)" half of architecture §11.1's
 * decision, load-bearing because a manifest re-authored with the same
 * fields in a different order (a cosmetic YAML edit, or a different
 * YAML-library key-emission order) must NOT look like a content change.
 * Array element order IS preserved (order is semantically meaningful for
 * an array — e.g. `capabilities`/`blocks` lists — unlike an object's key
 * order, which is not).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Pack content hash (architecture §11.1). `blockSources` is keyed by block
 * id (e.g. "github.create_issue") mapped to that block's implementation
 * source text. The hash input is built as one JSON structure — `{ manifest,
 * blocks: [{ name, source }, ...], workflows: [{ name, source }, ...] }`,
 * both asset collections sorted by name — rather than
 * hand-concatenated strings with separator characters: JSON.stringify
 * already escapes string boundaries correctly (a source file containing a
 * quote, newline, or any other byte can never be mistaken for a
 * field/record boundary the way a hand-picked separator character could
 * be), so building the hash input as one canonicalized JSON document gets
 * that correctness for free instead of re-deriving it. Sorting by block id
 * (not the manifest's own `blocks:` list order) means a cosmetic
 * reordering of the `blocks:` YAML array — no actual content change —
 * does not itself change the hash.
 *
 * On load, recompute this from the pack's current manifest + block/workflow
 * sources
 * and compare against the hash recorded at approval time — a mismatch
 * means the approval seal is broken (spec §16.2's "any edit breaks
 * approval seal"). Recomputation is this package's job
 * (`recomputePackManifest`, manifest.ts); the COMPARISON + what-to-do-about-
 * a-mismatch is governance's (`isPackSealBroken`, S4) — see SEAMS.md.
 */
export function computePackContentHash(
  manifest: Record<string, unknown>,
  blockSources: Readonly<Record<string, string>>,
  workflowSources: Readonly<Record<string, string>> = {},
): string {
  const hashManifest = { ...manifest };
  // These fields were introduced after block-only Pack seals existed.
  // Parser-supplied empty defaults must not alter the historical wire
  // representation of YAML that omitted them.
  for (const key of ["categories", "tags", "workflows", "tools"] as const) {
    if (Array.isArray(hashManifest[key]) && hashManifest[key].length === 0) {
      delete hashManifest[key];
    }
  }
  const compatibility = hashManifest["compatibility"];
  if (compatibility && typeof compatibility === "object" && !Array.isArray(compatibility)) {
    const normalized = { ...(compatibility as Record<string, unknown>) };
    if (Array.isArray(normalized["runtimes"]) && normalized["runtimes"].length === 0) delete normalized["runtimes"];
    hashManifest["compatibility"] = normalized;
  }
  const blocks = Object.keys(blockSources)
    .sort()
    .map((name) => ({ name, source: blockSources[name] }));
  const workflows = Object.keys(workflowSources)
    .sort()
    .map((name) => ({ name, source: workflowSources[name] }));
  // Preserve the pre-workflow hash wire format for existing block-only
  // Packs. Workflow Packs extend the payload only when workflow bytes are
  // actually present, so an upgrade cannot invalidate an unchanged
  // historical block-only approval.
  const payload = canonicalize(workflows.length > 0 ? { manifest: hashManifest, blocks, workflows } : { manifest: hashManifest, blocks });
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `sha256:${digest}`;
}
