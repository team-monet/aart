import { afterAll, describe, expect, it } from "vitest";
import { closeAllBrowserSessions, closeBrowserSession, getConsoleErrors, getOrCreatePage, hasSession } from "./browser-session.js";

// These tests launch a real headless Chromium (same platform dependency
// S0's scripts/smoke/browser.mjs already proves works in this
// environment) — they're the slower end of this package's suite by
// necessity, not an oversight.
describe("browser-session", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("reports no session for a runId that has never been used", () => {
    expect(hasSession("run-never-used")).toBe(false);
    expect(getConsoleErrors("run-never-used")).toBeUndefined();
  });

  it("creates a session lazily on first use and reuses the same page across calls", async () => {
    const runId = "run-session-continuity";
    const page1 = await getOrCreatePage(runId);
    await page1.setContent("<html><body><h1 id='t'>first</h1></body></html>");

    const page2 = await getOrCreatePage(runId);
    expect(page2).toBe(page1);
    const text = await page2.textContent("#t");
    expect(text).toBe("first");

    await closeBrowserSession(runId);
  });

  it("isolates sessions between different runIds", async () => {
    const pageA = await getOrCreatePage("run-a");
    const pageB = await getOrCreatePage("run-b");
    expect(pageA).not.toBe(pageB);

    await pageA.setContent("<html><body>A</body></html>");
    await pageB.setContent("<html><body>B</body></html>");

    expect(await pageA.textContent("body")).toBe("A");
    expect(await pageB.textContent("body")).toBe("B");

    await closeBrowserSession("run-a");
    await closeBrowserSession("run-b");
  });

  it("tracks console.error and pageerror output per session", async () => {
    const runId = "run-console-errors";
    const page = await getOrCreatePage(runId);
    await page.setContent("<html><body>x</body></html>");
    await page.evaluate(() => console.error("boom-from-page"));
    // Give the console event a tick to be delivered.
    await page.waitForTimeout(50);

    const errors = getConsoleErrors(runId);
    expect(errors).toContain("boom-from-page");

    await closeBrowserSession(runId);
  });

  it("closeBrowserSession evicts the session and is a no-op for an unknown runId", async () => {
    const runId = "run-to-close";
    await getOrCreatePage(runId);
    expect(hasSession(runId)).toBe(true);

    await closeBrowserSession(runId);
    expect(hasSession(runId)).toBe(false);

    await expect(closeBrowserSession("run-never-existed")).resolves.toBeUndefined();
  });
});
