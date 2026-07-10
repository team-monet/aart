import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserFillBlock } from "./fill.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.fill", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserFillBlock.manifest.id).toBe("browser.fill");
    expect(browserFillBlock.manifest.capabilities).toEqual(["browser"]);
    expect(browserFillBlock.manifest.category).toBe("browser");
  });

  it("fills a form input on the current page", async () => {
    const ctx = fakeExecutionContext({ runId: "run-fill-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<input id='email' />" }, ctx);
    const result = await browserFillBlock.execute({ selector: "#email", value: "a@b.com" }, ctx);
    expect(result).toEqual({ filled: true, selector: "#email" });
  });

  it("rejects (throws) when the selector doesn't match within the timeout", async () => {
    const ctx = fakeExecutionContext({ runId: "run-fill-missing" });
    await browserGotoBlock.execute({ url: "data:text/html,<body></body>" }, ctx);
    await expect(browserFillBlock.execute({ selector: "#nope", value: "x", timeoutMs: 300 }, ctx)).rejects.toThrow();
  });
});
