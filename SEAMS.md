# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S3 Core block packs

### S3-E1 — Browser session lifecycle — `closeBrowserSession`/`closeAllBrowserSessions`, expected to be called by S1 (`@aart/engine`) / S2 (`@aart/server` worker)

```ts
// packages/blocks-core/src/lib/browser-session.ts
export async function getOrCreatePage(runId: string): Promise<Page>;          // internal — used by browser.*/web.read blocks only
export function getConsoleErrors(runId: string): string[] | undefined;        // internal — used by assert.no_console_errors only
export function hasSession(runId: string): boolean;
export async function closeBrowserSession(runId: string): Promise<void>;      // <-- the seam
export async function closeAllBrowserSessions(): Promise<void>;               // <-- the seam
```

`BlockExecutionContext` (architecture §2.5, S0-frozen) carries no page/session handle and no run-completion or process-shutdown hook — it's `runId`/`stepId`/`resolveSecret`/`writeArtifact` only. But a real workflow's `browser.*` steps are a SEQUENCE acting on the same logical page (`browser.goto`, then `browser.click`, then `browser.screenshot`), and architecture §4.2 dispatches each step's block independently with no continuity primitive of its own. `@aart/blocks-core` supplies that continuity itself, process-side: one Playwright `BrowserContext`+`Page` per `runId`, created lazily on that run's first `browser.*`/`web.read` call (via a single **lazy**-launched shared headless Chromium — `playwright` is never `import()`-ed until the first browser block actually executes) and reused by every subsequent `browser.*` call in the same run. `assert.no_console_errors` reads the same per-run session's tracked `console.error`/`pageerror` output.

Nothing in `@aart/blocks-core`'s own scope ever calls `closeBrowserSession`/`closeAllBrowserSessions` — this package has no run-completion or process-shutdown signal of its own to act on. **Expected consumer:** the engine (S1) once a run reaches a terminal status, and/or the worker process (S2, architecture §4.7's graceful-shutdown sequence) on `SIGTERM`, should call `closeBrowserSession(runId)` / `closeAllBrowserSessions()` respectively. Until wired in, a run's browser session is only ever cleaned up by explicit test teardown or process exit — this is a real, currently-unclosed resource-lifecycle gap, flagged here rather than silently left for S9's integration pass to discover. If S1/S2's real shape for "a run reached a terminal state" or "the worker is shutting down" doesn't fit a bare `closeBrowserSession(runId)` call (e.g. it wants a registered callback instead of being the caller), reconcile via this file / the amendment protocol rather than either side silently guessing.

### S3-E2 — Block catalog composition — `createBlockCatalog`/`getBlockCatalog`, expected to be called by S1 (`@aart/engine`'s dispatch loop) and/or S9 (integration composition root)

```ts
// packages/blocks-core/src/catalog.ts
export interface BlocksCoreDeps {
  scorerRegistry?: ScorerRegistryPort;   // eval/scorer-registry-port.ts — injected into eval.run/eval.score
  reportRenderers?: ReportRenderersPort; // artifact-report/report-renderers-port.ts — injected into report.summarize/markdown/json
}
export function createBlockCatalog(deps?: BlocksCoreDeps): BlockImplementation[]; // all 51 blocks
export function getBlockCatalog(): BlockImplementation[];                        // createBlockCatalog({}) convenience default
export function getBlockGroupCounts(): Record<string, number>;
```

This is `@aart/blocks-core`'s single assembly point — the array `@aart/engine`'s dispatch loop (architecture §4.2, "dispatch to block") needs to resolve a `step.uses` block id against. Every `BlockManifest`/`BlockImplementation` in the returned array is real and complete regardless of `deps` (manifest construction never depends on injection — only calling `execute()` on `eval.run`/`eval.score` without a resolvable `ScorerRegistryPort` throws `ScorerRegistryUnavailableError`). Once S9 merges S6's real `@aart/evidence`, the composition root should call `createBlockCatalog({ scorerRegistry: createScorerRegistry(...), reportRenderers: createReportRenderers(...) })` using S6's real exports (SEAMS.md E2/E3 above) — no block rewrite needed, per this session's own injected-boundary brief. Until that wiring exists, `getBlockCatalog()`/`createBlockCatalog({})` still work today: eval blocks lazy-`import("@aart/evidence")` at call time and throw a clear error while it's still S0's stub; report blocks lazy-`import` the same way but fall back to a real local renderer (`createFallbackReportRenderers`) instead of throwing.
