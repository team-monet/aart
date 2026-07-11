// escapeHtml — the one HTML-escaping primitive this package still has a
// live consumer for: stub-deps.ts's createReportRenderers `html()` renderer
// (the run-detail execution report embedded into the SPA's Run Detail page
// via `dangerouslySetInnerHTML`, server.ts's GET /api/runs/:id). Every
// dynamic value rendered into that report must go through this — including
// redacted-but-still-attacker-influenced fields like a StepTrace's `error`.
//
// This package's OWN page rendering (page()/table()/form()/hiddenField()/
// textField(), and the server-rendered `views/*.ts` handlers that called
// them) is gone — server.ts now serves the packages/dashboard/frontend
// React SPA (static files) plus a JSON API, not server-rendered HTML pages.
// escapeHtml is the one piece of that surface with a genuine remaining
// caller; everything else was deleted alongside `views/`, not kept
// "in case," to avoid maintaining dead output nothing renders.
export function escapeHtml(value: unknown): string {
  const str = value === undefined || value === null ? "" : String(value);
  return str.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
