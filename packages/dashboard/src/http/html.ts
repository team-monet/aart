// Minimal server-rendered HTML helpers — architecture §13.1's `[DECISION]`
// "server-rendered (not a separate SPA build)". No templating engine
// dependency (matches this workspace's repeated "no framework dependency
// where the built-in surface is adequate" convention, e.g. @aart/server's
// hand-rolled router) — just tagged output + a shared page shell.

/** Escapes text for safe embedding in HTML. Every dynamic value rendered into a page must go through this — including redacted-but-still-attacker-influenced fields like a Correction's `reason` or a Workflow's `name`. */
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

/** Wraps `bodyHtml` in a minimal shared page shell. Deliberately not styled beyond structure — this package's DoD is correct server-rendered data + writable-action wiring, not visual design. */
export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)} — AART Dashboard</title></head>
<body>
<nav>
  <a href="/runs">Runs</a> | <a href="/workflows">Workflows</a> | <a href="/blocks">Blocks</a> |
  <a href="/packs">Packs</a> | <a href="/artifacts">Artifacts</a> | <a href="/waiting-runs">Waiting Runs</a> |
  <a href="/flagged-runs">Flagged Runs</a> | <a href="/approvals">Approvals</a> | <a href="/corrections">Corrections</a> |
  <a href="/evals">Evals</a> | <a href="/environments">Environments</a> | <a href="/deployments">Deployments</a> |
  <a href="/secrets">Secrets</a> | <a href="/worker-health">Worker Health</a>
</nav>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
}

/** Renders a `<table>` from rows of already-escaped-or-safe cell HTML (caller is responsible for escaping any raw data before passing it here — this helper only assembles structure, matching how `renderRows`/callers below always route values through `escapeHtml` first). */
export function table(headers: string[], rows: string[][]): string {
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table>\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

/** A minimal HTML `<form>` wrapper for a writable action — `method` is always POST (this package exposes no PUT/DELETE/PATCH routes, matching @aart/server's own HTTP surface convention). */
export function form(action: string, fields: string, submitLabel: string): string {
  return `<form method="post" action="${escapeHtml(action)}">\n${fields}\n<button type="submit">${escapeHtml(submitLabel)}</button>\n</form>`;
}

export function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export function textField(name: string, label: string, value = ""): string {
  return `<label>${escapeHtml(label)}: <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value)}"></label><br>`;
}
