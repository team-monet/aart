// Blocks, Packs (v1 — architecture §13.1's page list). Genuine, honestly-
// flagged gaps: block catalogs live in `@aart/blocks-core` (S3, a compiled-
// in registry, not AartStore data) and pack listing has no "list every
// known pack name" AartStore method (`PackManifestStore` only supports
// `listVersions(name)` for an ALREADY-KNOWN name — see packages/store/src/
// types.ts) — neither is reachable from this package without either a new
// AartStore method (an AMENDMENTS.md-worthy frozen-interface change this
// session isn't taking unilaterally) or an S2 HTTP route neither
// SEAMS.md nor the documented route list currently publishes. Rendered as
// clearly-labeled pending pages rather than silently faked data — matches
// this whole workspace's "stub honestly, don't pretend" convention (e.g.
// S6's llm_judge throwing a clear error with no judge wired, S2's
// `/dashboard/*` reserved-but-unimplemented mount point).
import { page } from "../http/html.js";

export function renderBlocksPage(): string {
  return page("Blocks", "<p>Pending: block catalog integration (owned by <code>@aart/blocks-core</code>, S3 — not yet landed in this worktree). See this package's SEAMS.md.</p>");
}

export function renderPacksPage(): string {
  return page("Packs", "<p>Pending: pack listing (no \"list every known pack\" <code>AartStore</code> method exists yet, and no S2 HTTP route is published for it). See this package's SEAMS.md.</p>");
}
