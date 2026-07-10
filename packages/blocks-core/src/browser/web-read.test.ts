import { afterAll, afterEach, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { webReadBlock } from "./web-read.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";
import { EgressDeniedError, setEgressPolicy } from "../lib/egress.js";

describe("web.read", () => {
  afterEach(() => setEgressPolicy({}));
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(webReadBlock.manifest.id).toBe("web.read");
    expect(webReadBlock.manifest.capabilities).toEqual(["browser"]);
    expect(webReadBlock.manifest.category).toBe("browser");
  });

  it("navigates to url and extracts main-content text, preferring <main>", async () => {
    const ctx = fakeExecutionContext({ runId: "run-webread-1" });
    const result = await webReadBlock.execute(
      { url: "data:text/html,<title>Article</title><nav>skip me</nav><main>the real content</main>" },
      ctx,
    );
    expect(result).toMatchObject({ title: "Article" });
    expect((result as { text: string }).text).toContain("the real content");
    expect((result as { text: string }).text).not.toContain("skip me");
  });

  it("reads the current page when url is omitted (distinct from browser.extract_text/text_visible)", async () => {
    const ctx = fakeExecutionContext({ runId: "run-webread-2" });
    await browserGotoBlock.execute({ url: "data:text/html,<body>already here</body>" }, ctx);
    const result = await webReadBlock.execute({}, ctx);
    expect((result as { text: string }).text).toContain("already here");
  });

  it("rejects navigation to a domain outside a configured egress allowlist", async () => {
    setEgressPolicy({ allowedDomains: ["allowed.example.com"] });
    const ctx = fakeExecutionContext({ runId: "run-webread-egress" });
    await expect(webReadBlock.execute({ url: "https://not-allowed.example.com/" }, ctx)).rejects.toThrow(EgressDeniedError);
  });
});
