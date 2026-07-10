import { describe, expect, it } from "vitest";
import { escapeHtml, form, hiddenField, page, table, textField } from "./html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  });

  it("stringifies non-string values and treats null/undefined as empty", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("page", () => {
  it("embeds an escaped title and the raw body", () => {
    const html = page("<b>Runs</b>", "<p>body</p>");
    expect(html).toContain("&lt;b&gt;Runs&lt;/b&gt;");
    expect(html).toContain("<p>body</p>");
    expect(html).toContain("<!doctype html>");
  });
});

describe("table", () => {
  it("renders headers and rows", () => {
    const html = table(["A", "B"], [["1", "2"]]);
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });
});

describe("form helpers", () => {
  it("form() renders a POST form with the given action and submit label", () => {
    const html = form("/flagged-runs/r1/clear", hiddenField("runId", "r1"), "Clear flag");
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/flagged-runs/r1/clear"');
    expect(html).toContain('value="r1"');
    expect(html).toContain("Clear flag");
  });

  it("textField() escapes the prefilled value", () => {
    const html = textField("reason", "Reason", `<script>`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
