import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserTextVisibleBlock } from "./text-visible.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.text_visible", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserTextVisibleBlock.manifest.id).toBe("browser.text_visible");
    expect(browserTextVisibleBlock.manifest.capabilities).toEqual(["browser"]);
    expect(browserTextVisibleBlock.manifest.category).toBe("browser");
  });

  it("returns true when the element is visible", async () => {
    const ctx = fakeExecutionContext({ runId: "run-tv-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<div id='ok'>hi</div>" }, ctx);
    await expect(browserTextVisibleBlock.execute({ selector: "#ok" }, ctx)).resolves.toEqual({ visible: true });
  });

  it("returns false (does not throw) when the element doesn't exist — a sensor, not an assertion", async () => {
    const ctx = fakeExecutionContext({ runId: "run-tv-2" });
    await browserGotoBlock.execute({ url: "data:text/html,<body></body>" }, ctx);
    await expect(browserTextVisibleBlock.execute({ selector: "#missing" }, ctx)).resolves.toEqual({ visible: false });
  });

  it("returns false for an element hidden via CSS", async () => {
    const ctx = fakeExecutionContext({ runId: "run-tv-3" });
    await browserGotoBlock.execute({ url: "data:text/html,<div id='hidden' style='display:none'>x</div>" }, ctx);
    await expect(browserTextVisibleBlock.execute({ selector: "#hidden" }, ctx)).resolves.toEqual({ visible: false });
  });
});
