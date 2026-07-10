import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";
import { EgressDeniedError, setEgressPolicy } from "../lib/egress.js";

describe("browser.goto", () => {
  afterAll(async () => {
    setEgressPolicy({});
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserGotoBlock.manifest.id).toBe("browser.goto");
    expect(browserGotoBlock.manifest.capabilities).toEqual(["browser"]);
    expect(browserGotoBlock.manifest.category).toBe("browser");
  });

  it("navigates the run's page and returns url/title/status", async () => {
    const ctx = fakeExecutionContext({ runId: "run-goto-1" });
    const result = await browserGotoBlock.execute({ url: "data:text/html,<title>Hi</title><body>x</body>" }, ctx);
    expect(result).toMatchObject({ title: "Hi" });
  });

  it("reuses the same page across two goto calls in the same run (session continuity)", async () => {
    const ctx = fakeExecutionContext({ runId: "run-goto-continuity" });
    await browserGotoBlock.execute({ url: "data:text/html,<title>First</title>" }, ctx);
    const second = await browserGotoBlock.execute({ url: "data:text/html,<title>Second</title>" }, ctx);
    expect(second).toMatchObject({ title: "Second" });
  });

  it("rejects navigation to a domain outside a configured egress allowlist", async () => {
    setEgressPolicy({ allowedDomains: ["allowed.example.com"] });
    const ctx = fakeExecutionContext({ runId: "run-goto-egress" });
    await expect(browserGotoBlock.execute({ url: "https://not-allowed.example.com/" }, ctx)).rejects.toThrow(EgressDeniedError);
  });
});
