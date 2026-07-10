import { afterAll, describe, expect, it } from "vitest";
import { assertNoConsoleErrorsBlock } from "./no-console-errors.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions, getOrCreatePage } from "../lib/browser-session.js";

describe("assert.no_console_errors", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata (capability: browser)", () => {
    expect(assertNoConsoleErrorsBlock.manifest.id).toBe("assert.no_console_errors");
    expect(assertNoConsoleErrorsBlock.manifest.capabilities).toEqual(["browser"]);
  });

  it("passes vacuously when no browser session exists yet for this run", async () => {
    const ctx = fakeExecutionContext({ runId: "run-no-console-errors-never-used" });
    await expect(assertNoConsoleErrorsBlock.execute({}, ctx)).resolves.toEqual({ passed: true, errors: [] });
  });

  it("passes when the run's browser session logged no console errors", async () => {
    const runId = "run-no-console-errors-clean";
    const page = await getOrCreatePage(runId);
    await page.setContent("<html><body>clean page</body></html>");
    await expect(assertNoConsoleErrorsBlock.execute({}, fakeExecutionContext({ runId }))).resolves.toEqual({ passed: true, errors: [] });
  });

  it("throws BlockAssertionError when the run's browser session logged a console error", async () => {
    const runId = "run-no-console-errors-dirty";
    const page = await getOrCreatePage(runId);
    await page.setContent("<html><body>x</body></html>");
    await page.evaluate(() => console.error("boom-from-page"));
    await page.waitForTimeout(50);

    await expect(assertNoConsoleErrorsBlock.execute({}, fakeExecutionContext({ runId }))).rejects.toThrow(BlockAssertionError);
  });
});
