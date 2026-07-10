// Tiny id-generation helper — mirrors the same `prefix_<random>` convention
// used elsewhere in the workspace (e.g. @aart/server's ids.ts) for
// human-scannable ids in dashboard-authored records (a new Correction's
// caller-side temp id where needed, a locally-authored EvalSuite id, etc.).
// Not a cross-session seam — purely local convenience.
export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
