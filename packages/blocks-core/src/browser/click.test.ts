import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserClickBlock } from "./click.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.click", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserClickBlock.manifest.id).toBe("browser.click");
    expect(browserClickBlock.manifest.capabilities).toEqual(["browser"]);
  });

  it("clicks an element on the page navigated to by a prior browser.goto in the same run", async () => {
    const ctx = fakeExecutionContext({ runId: "run-click-1" });
    await browserGotoBlock.execute(
      { url: "data:text/html,<button id='btn' onclick=\"document.title='clicked'\">Go</button>" },
      ctx,
    );
    const result = await browserClickBlock.execute({ selector: "#btn" }, ctx);
    expect(result).toEqual({ clicked: true, selector: "#btn" });
  });

  it("rejects (throws) when the selector doesn't match anything within the timeout", async () => {
    const ctx = fakeExecutionContext({ runId: "run-click-missing" });
    await browserGotoBlock.execute({ url: "data:text/html,<body>empty</body>" }, ctx);
    await expect(browserClickBlock.execute({ selector: "#does-not-exist", timeoutMs: 300 }, ctx)).rejects.toThrow();
  });
});
