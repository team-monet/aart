import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserHtmlBlock } from "./html.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions, getOrCreatePage } from "../lib/browser-session.js";

describe("browser.html", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserHtmlBlock.manifest.id).toBe("browser.html");
    expect(browserHtmlBlock.manifest.capabilities).toEqual(["browser"]);
    expect(browserHtmlBlock.manifest.category).toBe("browser");
  });

  it("returns the full page HTML when no selector is given", async () => {
    const ctx = fakeExecutionContext({ runId: "run-html-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<body><p>hi</p></body>" }, ctx);
    const result = (await browserHtmlBlock.execute({}, ctx)) as { html: string };
    expect(result.html).toContain("<p>hi</p>");
  });

  it("returns just the matched element's innerHTML when a selector is given", async () => {
    const ctx = fakeExecutionContext({ runId: "run-html-2" });
    await browserGotoBlock.execute({ url: "data:text/html,<div id='box'><span>inner</span></div>" }, ctx);
    const result = (await browserHtmlBlock.execute({ selector: "#box" }, ctx)) as { html: string };
    expect(result.html).toBe("<span>inner</span>");
  });

  it("rejects (throws) when a given selector matches nothing", async () => {
    const ctx = fakeExecutionContext({ runId: "run-html-missing" });
    await browserGotoBlock.execute({ url: "data:text/html,<body>empty</body>" }, ctx);
    const page = await getOrCreatePage(ctx.runId);
    page.setDefaultTimeout(300);
    await expect(browserHtmlBlock.execute({ selector: "#does-not-exist" }, ctx)).rejects.toThrow();
  });
});
