import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserSnapshotBlock } from "./snapshot.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.snapshot", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserSnapshotBlock.manifest.id).toBe("browser.snapshot");
    expect(browserSnapshotBlock.manifest.capabilities).toEqual(["browser"]);
    expect(browserSnapshotBlock.manifest.category).toBe("browser");
  });

  it("returns a structured (YAML-ish) accessibility snapshot mentioning interactive elements", async () => {
    const ctx = fakeExecutionContext({ runId: "run-snapshot-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<button>Click me</button>" }, ctx);
    const result = (await browserSnapshotBlock.execute({}, ctx)) as { snapshot: string };
    expect(result.snapshot).toContain("button");
    expect(result.snapshot).toContain("Click me");
  });

  it("resolves without throwing for a page with no interactive elements", async () => {
    const ctx = fakeExecutionContext({ runId: "run-snapshot-empty" });
    await browserGotoBlock.execute({ url: "data:text/html,<body></body>" }, ctx);
    await expect(browserSnapshotBlock.execute({}, ctx)).resolves.toBeDefined();
  });
});
