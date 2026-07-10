// artifact-exists.ts — "artifact exists", spec §24.3. Neither spec nor
// architecture specifies what `actual` looks like for this scorer kind (the
// (actual, expected, config) contract is generic across all 12 kinds); this
// module documents its own convention: `actual` is either an `Artifact[]`
// directly, or an object carrying one under an `artifacts` key (the natural
// shape of e.g. a RunRecord slice) — a caller assembling `actual` for this
// scorer picks whichever is more convenient.
import type { Artifact } from "@aart/types";
import type { PureScorerFn } from "./types.js";

export interface ArtifactExistsConfig {
  name?: string;
  kind?: string;
}

function toArtifactArray(actual: unknown): Artifact[] {
  if (Array.isArray(actual)) return actual as Artifact[];
  if (actual && typeof actual === "object" && Array.isArray((actual as { artifacts?: unknown }).artifacts)) {
    return (actual as { artifacts: Artifact[] }).artifacts;
  }
  return [];
}

export const artifactExists: PureScorerFn = (actual, expected, config) => {
  const cfg = config as ArtifactExistsConfig | undefined;
  const name = cfg?.name ?? (typeof expected === "string" ? expected : undefined);
  const kind = cfg?.kind;
  const artifacts = toArtifactArray(actual);
  const passed = artifacts.some((a) => (!name || a.name === name) && (!kind || a.kind === kind));
  return { passed, score: passed ? 1 : 0, deterministic: true, detail: `${artifacts.length} artifact(s) checked` };
};
