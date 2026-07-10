import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserBackBlock } from "./back.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.back", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserBackBlock.manifest.id).toBe("browser.back");
    expect(browserBackBlock.manifest.capabilities).toEqual(["browser"]);
    expect(browserBackBlock.manifest.category).toBe("browser");
  });

  it("navigates back to the previous page in this run's history", async () => {
    const ctx = fakeExecutionContext({ runId: "run-back-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<title>First</title>" }, ctx);
    await browserGotoBlock.execute({ url: "data:text/html,<title>Second</title>" }, ctx);
    const result = await browserBackBlock.execute({}, ctx);
    expect(result).toMatchObject({ title: "First" });
  });

  it("resolves (does not throw) rather than erroring when there is no history to go back to", async () => {
    const ctx = fakeExecutionContext({ runId: "run-back-empty" });
    await browserGotoBlock.execute({ url: "data:text/html,<title>Only</title>" }, ctx);
    const result = await browserBackBlock.execute({}, ctx);
    expect(result).toEqual({ url: "about:blank", title: "" });
  });
});
