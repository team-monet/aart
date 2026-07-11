import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.js";

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
