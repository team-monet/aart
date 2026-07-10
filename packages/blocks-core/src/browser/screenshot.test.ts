import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserScreenshotBlock } from "./screenshot.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.screenshot", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata (capabilities: browser + file.write)", () => {
    expect(browserScreenshotBlock.manifest.id).toBe("browser.screenshot");
    expect(browserScreenshotBlock.manifest.capabilities).toEqual(["browser", "file.write"]);
    expect(browserScreenshotBlock.manifest.category).toBe("browser");
  });

  it("captures a full-page screenshot and writes it as an artifact", async () => {
    const ctx = fakeExecutionContext({ runId: "run-shot-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<body style='background:red'>hi</body>" }, ctx);
    const result = await browserScreenshotBlock.execute({ fullPage: true }, ctx);
    expect(result).toMatchObject({ id: expect.any(String), path: expect.any(String) });
    expect(ctx.writtenArtifacts).toHaveLength(1);
    expect(ctx.writtenArtifacts[0]).toMatchObject({ name: "screenshot.png", kind: "screenshot", mime: "image/png" });
    expect(ctx.writtenArtifacts[0]!.bytes.length).toBeGreaterThan(0);
  });

  it("accepts maskSelectors against a fixture page with a maskable region without erroring", async () => {
    const ctx = fakeExecutionContext({ runId: "run-shot-mask" });
    await browserGotoBlock.execute(
      { url: "data:text/html,<div id='secret'>sk-12345</div><div id='public'>visible</div>" },
      ctx,
    );
    const result = await browserScreenshotBlock.execute({ fullPage: true, maskSelectors: ["#secret"] }, ctx);
    expect(result).toMatchObject({ id: expect.any(String), path: expect.any(String) });
    expect(ctx.writtenArtifacts[0]!.bytes.length).toBeGreaterThan(0);
  });

  it("screenshots a single element when selector is given", async () => {
    const ctx = fakeExecutionContext({ runId: "run-shot-selector" });
    await browserGotoBlock.execute({ url: "data:text/html,<div id='box' style='width:50px;height:50px;background:blue'></div>" }, ctx);
    const result = await browserScreenshotBlock.execute({ selector: "#box" }, ctx);
    expect(result).toMatchObject({ id: expect.any(String) });
  });
});
