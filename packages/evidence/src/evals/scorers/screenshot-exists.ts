// screenshot-exists.ts — "screenshot exists", spec §24.3. Same convention
// as artifact_exists (see that module's doc comment for the `actual` shape)
// with `kind` defaulted to "screenshot" (spec §13.7's Artifact.kind).
import type { PureScorerFn } from "./types.js";
import { artifactExists, type ArtifactExistsConfig } from "./artifact-exists.js";

export const screenshotExists: PureScorerFn = (actual, expected, config) => {
  const cfg = config as ArtifactExistsConfig | undefined;
  return artifactExists(actual, expected, { ...cfg, kind: cfg?.kind ?? "screenshot" });
};
