<!-- Append this to your project's CLAUDE.md to make "verify it actually renders" a reflex. -->

## Verifying runtime changes (aart)

When you change something that affects how a **page renders or a service responds** — UI, a route, an API shape, a component — do not claim it works from reading the code or unit tests alone. Call the aart MCP tool **`aa_verify({ url, expect? })`**: it loads the page in a real browser, waits for it to settle, and returns a compact view (title, rendered text, interactive elements, console errors, a screenshot) plus `ok` if you pass `expect`. Treat its result as the source of truth for "did it render." Reach for it the way you reach for the test suite — as part of finishing, not when asked.

(`aa_find_blocks {category|query}` to discover other capabilities; `aa_get_report({ runId })` for the full evidence. Approval is off by default — no gate between authoring and running.)
