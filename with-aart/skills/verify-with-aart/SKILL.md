---
name: verify-with-aart
description: Use right after a change that affects how a web page renders or a service responds — to actually SEE whether it works before claiming done. Calls aart's aa_verify (one call: loads the page in a real browser, returns a compact rendered view + pass/fail).
---

# Verify a change with aart

When you've just changed something that affects a **rendered page or a running service** — a UI component, a route, a template, an endpoint a page consumes — do not declare it works from reading the code or running unit tests. They don't tell you whether the page actually renders.

Call **`aa_verify`** (aart MCP):

```
aa_verify({ url: "<the page you changed>", expect: "<text you expect to see>" })
```

It loads the URL in a real headless browser, waits for the page to settle (including JS‑rendered SPAs), and returns a compact verdict — small enough to read in one glance:

- `ok` — whether your `expect` text is present (omit `expect` to just *perceive* the page)
- `title`, `text` (the main rendered content), `elements` (interactive elements + selectors), `consoleErrors`, a `screenshot` path, and a `runId`

Read it:
- `ok: true` and `consoleErrors.count === 0` → it rendered. You can claim done.
- `ok: false` or `consoleErrors.count > 0` → it didn't. Open the `screenshot` artifact, read the `text`, fix, and re‑verify.
- `status: "unreachable"` → the page didn't load (server down, wrong URL, or browser not installed — the `hint` says which).

Need to dig deeper? `aa_get_report({ runId })` returns the full trace and every artifact (including the complete page text).

Reach for this as part of **finishing** a runtime/UI change — the way you'd run the test suite — not only when asked.
