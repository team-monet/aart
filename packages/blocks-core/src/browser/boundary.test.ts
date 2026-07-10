// Dedicated boundary test — spec §15.3's Browser boundary note, and this
// session's own DoD line item: "web.read/browser.extract_text/
// browser.text_visible boundary ... tested explicitly — a fixture page
// where all three are exercised and their distinct outputs (text/text/
// boolean) are asserted." Each block already has its own focused test
// file; this one specifically proves the three-way distinction the spec
// calls out holds on ONE shared fixture page, side by side, rather than
// three separately-plausible-but-never-jointly-verified claims:
//
//   - web.read           -> high-level MAIN-CONTENT text (skips nav/chrome)
//   - browser.extract_text -> RAW text of a specific selector (no content heuristic)
//   - browser.text_visible -> a BOOLEAN sensor, never raw text at all
import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserExtractTextBlock } from "./extract-text.js";
import { browserTextVisibleBlock } from "./text-visible.js";
import { webReadBlock } from "./web-read.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

const FIXTURE_URL =
  "data:text/html,<title>Product Page</title>" +
  "<nav>Home | About | Contact</nav>" +
  "<main><h1>Widget 3000</h1><p id='price'>$19.99</p></main>" +
  "<footer>Copyright 2026</footer>";

describe("Browser boundary: web.read vs browser.extract_text vs browser.text_visible", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("all three blocks, run against the same fixture page, produce their own distinct output shape", async () => {
    const ctx = fakeExecutionContext({ runId: "run-boundary-1" });
    await browserGotoBlock.execute({ url: FIXTURE_URL }, ctx);

    // web.read: high-level main-content text — includes the <main> content,
    // excludes the <nav>/<footer> chrome around it.
    const webRead = (await webReadBlock.execute({}, ctx)) as { text: string };
    expect(webRead.text).toContain("Widget 3000");
    expect(webRead.text).toContain("$19.99");
    expect(webRead.text).not.toContain("Home | About | Contact");
    expect(webRead.text).not.toContain("Copyright 2026");

    // browser.extract_text: raw, selector-scoped text — no main-content
    // heuristic at all, just whatever the given selector contains.
    const extracted = (await browserExtractTextBlock.execute({ selector: "#price" }, ctx)) as { text: string };
    expect(extracted.text).toBe("$19.99");

    // browser.text_visible: a boolean sensor — never returns text, and
    // reports true/false regardless of the element's actual content.
    const visiblePrice = (await browserTextVisibleBlock.execute({ selector: "#price" }, ctx)) as { visible: boolean };
    expect(visiblePrice).toEqual({ visible: true });
    expect(typeof visiblePrice.visible).toBe("boolean");

    const visibleMissing = (await browserTextVisibleBlock.execute({ selector: "#does-not-exist" }, ctx)) as { visible: boolean };
    expect(visibleMissing).toEqual({ visible: false });

    // Cross-check: the three outputs are genuinely different shapes, not
    // just different values of the same shape.
    expect(typeof webRead.text).toBe("string");
    expect(typeof extracted.text).toBe("string");
    expect(webRead.text).not.toBe(extracted.text); // main-content text != one element's raw text
    expect(typeof visiblePrice.visible).toBe("boolean");
  });
});
