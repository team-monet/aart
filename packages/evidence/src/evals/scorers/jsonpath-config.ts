// jsonpath-config.ts — the scorerConfig shape shared by jsonpath_exact and
// jsonpath_contains (spec §24.3): both need to know WHICH path within
// `actual` to check, and neither spec nor architecture gives that
// parameter a name — `path` was chosen as the obvious, JSONPath-library-
// convention name.
export interface JsonPathScorerConfig {
  path: string;
}

export function extractPath(config: unknown): string {
  const path = (config as Partial<JsonPathScorerConfig> | undefined)?.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('jsonpath scorer requires config.path (e.g. { path: "$.outputs.nmi" })');
  }
  return path;
}
