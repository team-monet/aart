// Browser session manager — shared by all 11 `browser.*`/`web.read` blocks
// (ADR-13: Playwright). Two things this module owns that no single block
// can own on its own:
//
// 1. LAZY Playwright (per this session's brief): `playwright` is only
//    ever `import()`-ed inside `launchSharedBrowser()`, the first time any
//    browser.* block actually executes — a workflow that never uses a
//    browser block never pays Playwright's module-load/browser-binary
//    cost. S0's platform smoke test (scripts/smoke/browser.mjs) already
//    proves a headless Chromium launches fine in this environment; this
//    module is what makes that capability available to blocks without
//    forcing it eagerly at package-import time.
//
// 2. Session continuity across steps: `BlockExecutionContext` (architecture
//    §2.5, frozen) carries no page/session handle — it's runId/stepId/
//    resolveSecret/writeArtifact only. But a real workflow's browser.*
//    steps are a SEQUENCE acting on the same logical page (goto, then
//    click, then screenshot) — architecture §4.2's per-step dispatch calls
//    each block's `execute` independently, with no continuity primitive of
//    its own. This module supplies that continuity itself, process-side,
//    keyed by `ctx.runId`: one `BrowserContext`+`Page` per run, created
//    lazily on that run's first browser.* call and reused by every
//    subsequent browser.* call in the same run.
//
// SEAM (recorded in SEAMS.md): nothing in this package's own scope ever
// calls `closeBrowserSession`/`closeAllBrowserSessions` — @aart/blocks-core
// has no run-completion or process-shutdown hook of its own. The engine
// (@aart/engine, S1) or worker process (@aart/server, S2) is expected to
// call `closeBrowserSession(runId)` once a run reaches a terminal status,
// and `closeAllBrowserSessions()` on graceful shutdown (architecture §4.7).
// Until that's wired in, sessions are cleaned up only by explicit test
// teardown or process exit.
import type { Browser, BrowserContext, Page } from "playwright";

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  consoleErrors: string[];
}

let sharedBrowser: Browser | undefined;
let launchPromise: Promise<Browser> | undefined;
const sessions = new Map<string, BrowserSession>();

async function launchSharedBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  if (!launchPromise) {
    launchPromise = (async () => {
      // Lazy — the whole point of this function existing separately from
      // module scope. `playwright` is a real `dependencies` entry (not
      // just a devDependency) precisely so this dynamic import resolves
      // in a production install too, not only in this workspace's own
      // dev/test environment.
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      sharedBrowser = browser;
      return browser;
    })();
  }
  return launchPromise;
}

/** Returns the run's page, creating a fresh isolated `BrowserContext`+`Page` (and, on first-ever call process-wide, the shared headless Chromium) if this run has no session yet. Also wires up the console/pageerror listeners `getConsoleErrors`/`assert.no_console_errors` read from. */
export async function getOrCreatePage(runId: string): Promise<Page> {
  const existing = sessions.get(runId);
  if (existing) return existing.page;

  const browser = await launchSharedBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(err instanceof Error ? err.message : String(err));
  });

  sessions.set(runId, { context, page, consoleErrors });
  return page;
}

/** `undefined` if `runId` has no active session (no browser.* block has executed for this run yet, or its session was already closed) — callers (assert.no_console_errors) treat that as "zero errors," not an error condition. */
export function getConsoleErrors(runId: string): string[] | undefined {
  return sessions.get(runId)?.consoleErrors;
}

export function hasSession(runId: string): boolean {
  return sessions.has(runId);
}

/** Closes and evicts one run's session. Safe to call for a runId with no session (no-op) — a terminal-status run that never touched a browser block shouldn't be an error case for whatever lifecycle hook calls this. */
export async function closeBrowserSession(runId: string): Promise<void> {
  const session = sessions.get(runId);
  if (!session) return;
  sessions.delete(runId);
  await session.context.close();
}

/** Closes every open session plus the shared browser itself — process-shutdown / test-teardown use. */
export async function closeAllBrowserSessions(): Promise<void> {
  const runIds = Array.from(sessions.keys());
  await Promise.all(runIds.map((runId) => closeBrowserSession(runId)));
  if (sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = undefined;
    launchPromise = undefined;
    await browser.close();
  }
}
