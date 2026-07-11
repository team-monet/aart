// Blocks, Packs (v1 — architecture §13.1's page list).
//
// S9 integration (reconciliation ledger item 13): the Blocks half of this
// file's original "genuine, honestly-flagged gap" is now closeable —
// `@aart/blocks-core` (S3) and `@aart/llm` (S7) have both landed in the
// merged repo, and this package now depends on them directly
// (capability-catalog.ts, built for the risk-diff page's real
// semanticRiskDiff wiring — reused here for its manifest listing too).
// renderBlocksPage now renders the real 56-block catalog.
//
// The Packs half remains a genuine, still-open gap, NOT resolved by the
// above — verified again at S9, not merely carried over stale: pack
// listing still has no "list every known pack name" AartStore method
// (`PackManifestStore` only supports `listVersions(name)` for an
// ALREADY-KNOWN name — see packages/store/src/types.ts, confirmed by
// direct re-read of the real, merged interface) and no S2 HTTP route
// exists for it either (confirmed against @aart/server's real, merged
// route list, packages/server/src/http/server.ts — no `/packs` route).
// Reconciliation ledger item 12 (root AMENDMENTS.md/SEAMS.md R1) hits the
// identical blocker from the governance-validation side; both are the
// same underlying data-model gap; both stay honestly DEFERRED rather than
// worked around with an invented "list every pack" heuristic (a new
// AartStore method is a frozen-interface change this integration pass
// isn't taking unilaterally). Still rendered as a clearly-labeled pending
// page, not silently faked data — matches this whole workspace's "stub
// honestly, don't pretend" convention (e.g. S6's llm_judge throwing a
// clear error with no judge wired, S2's `/dashboard/*`
// reserved-but-unimplemented mount point).
import type { BlockManifest } from "@aart/types";
import { escapeHtml, page, table } from "../http/html.js";

export function renderBlocksPage(manifests: readonly BlockManifest[]): string {
  const sorted = [...manifests].sort((a, b) => a.id.localeCompare(b.id));
  const rows = sorted.map((m) => [
    `<code><a href="/blocks/${escapeHtml(m.id)}">${escapeHtml(m.id)}</a></code>`,
    escapeHtml(m.category ?? ""),
    escapeHtml(m.capabilities.join(", ")),
    escapeHtml(m.description),
  ]);
  return page("Blocks", `<p>${sorted.length} block(s) — @aart/blocks-core + @aart/llm core built-ins. Pack-delivered blocks are not yet listable here (see Packs page).</p>${table(["Id", "Category", "Capabilities", "Description"], rows)}`);
}

/** Block detail (previously a genuine gap — no route, no view, no link existed anywhere; a founder test drive confirmed there was no way to reach a single block's own manifest, root AMENDMENTS.md A43). Renders every `BlockManifest` field (architecture §2.5's frozen shape, `packages/types/src/block.ts`) the Blocks list doesn't already show in its table: version, and the full input/output JSON Schemas derived from the block's own Zod shape (`json-schema.ts`) — the same schemas the engine validates `with:`/step outputs against at dispatch, so this is the authoring-time equivalent of that runtime check. */
export function renderBlockDetailPage(manifest: BlockManifest): string {
  const body = `<p>Version: ${escapeHtml(manifest.version)}${manifest.category ? ` — Category: ${escapeHtml(manifest.category)}` : ""}</p>
<p>${escapeHtml(manifest.description)}</p>
<h2>Capabilities</h2>
${manifest.capabilities.length > 0 ? `<ul>${manifest.capabilities.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join("")}</ul>` : "<p>(none)</p>"}
<h2>Input Schema</h2>
<pre>${escapeHtml(JSON.stringify(manifest.inputSchema, null, 2))}</pre>
<h2>Output Schema</h2>
<pre>${escapeHtml(JSON.stringify(manifest.outputSchema, null, 2))}</pre>`;
  return page(`Block ${manifest.id}`, body);
}

export function renderPacksPage(): string {
  return page("Packs", "<p>Pending: pack listing (no \"list every known pack\" <code>AartStore</code> method exists yet, and no @aart/server HTTP route is published for it). See this package's SEAMS.md.</p>");
}
