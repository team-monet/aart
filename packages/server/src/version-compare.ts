/** Naive semver-ish comparator (numeric segments compare numerically, non-numeric segments compare lexically) — shared by every "pick the latest version" call site in this package (bundle closure resolution, registry-entry resolution). Same small algorithm the store's fs/sqlite adapters each independently carry for `WorkflowStore.getLatest` — kept here as this package's own single copy rather than importing an adapter-internal helper across a package boundary. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (sa !== "" && sb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export function highestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions).at(-1);
}
