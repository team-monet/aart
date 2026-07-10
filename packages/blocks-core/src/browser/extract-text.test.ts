import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserExtractTextBlock } from "./extract-text.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.extract_text", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserExtractTextBlock.manifest.id).toBe("browser.extract_text");
    expect(browserExtractTextBlock.manifest.capabilities).toEqual(["browser"]);
  });

  it("extracts the raw text content of a specific element", async () => {
    const ctx = fakeExecutionContext({ runId: "run-extract-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<div id='total'>$42.00</div>" }, ctx);
    await expect(browserExtractTextBlock.execute({ selector: "#total" }, ctx)).resolves.toEqual({ text: "$42.00" });
  });

  it("throws when the selector matches nothing (unlike the text_visible sensor)", async () => {
    const ctx = fakeExecutionContext({ runId: "run-extract-missing" });
    await browserGotoBlock.execute({ url: "data:text/html,<body></body>" }, ctx);
    // Playwright's default actionability timeout is 30s — pass a short
    // explicit timeoutMs so this "it doesn't exist" case fails fast rather
    // than waiting out Playwright's full default.
    await expect(browserExtractTextBlock.execute({ selector: "#nope", timeoutMs: 500 }, ctx)).rejects.toThrow();
  }, 10_000);
});
