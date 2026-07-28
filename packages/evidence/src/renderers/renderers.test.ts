import { describe, expect, it } from "vitest";
import { identityRedact, type RedactFn } from "../redact.js";
import { fixtureRunRecord } from "../test-support/fixtures.js";
import { renderCliText } from "./cli-text.js";
import { renderHtml } from "./html.js";
import { createReportRenderers } from "./index.js";
import { renderJson } from "./json.js";
import { renderMarkdown } from "./markdown.js";
import { renderModelFacing } from "./model-facing.js";
import { renderPrComment } from "./pr-comment.js";

const SECRET_VALUE = "sk-live-VERY-SECRET-TOKEN";

/** A test fake that scrubs one known literal secret value wherever it appears in the record's JSON form — a minimal stand-in for S4's real value-scan-and-replace redactRecord (architecture §7.9), just enough to prove renderers actually route through the injected function rather than merely accepting and ignoring it. */
function makeTestRedactor(secretValue: string, marker = "[REDACTED:TEST_SECRET]"): RedactFn {
  return (record) => JSON.parse(JSON.stringify(record).split(secretValue).join(marker));
}

function secretBearingRun() {
  return fixtureRunRecord({
    status: "failed",
    outputs: { tokenEcho: SECRET_VALUE },
    trace: [
      {
        seq: 0,
        stepId: "call_api",
        block: "http.request",
        status: "failed",
        inputs: { authHeader: `Bearer ${SECRET_VALUE}` },
        outputs: { body: `echoed back: ${SECRET_VALUE}` },
        error: `request failed, token ${SECRET_VALUE} was rejected`,
        startedAt: "t",
      },
    ],
  });
}

describe("workflow outputs are first-class report results", () => {
  const run = fixtureRunRecord({ status: "completed", outputs: { items: ["alpha", "beta"], count: 2 } });

  it("renders outputs directly in model, markdown, HTML, PR-comment, and CLI-text formats", () => {
    expect(renderModelFacing(run, identityRedact).outputs).toEqual({ items: ["alpha", "beta"], count: 2 });
    expect(renderMarkdown(run, identityRedact)).toContain('"items": [');
    expect(renderHtml(run, identityRedact)).toContain("<h2>Outputs</h2>");
    expect(renderPrComment(run, identityRedact)).toContain("Outputs:");
    expect(renderCliText(run, identityRedact)).toContain('outputs: {"items":["alpha","beta"],"count":2}');
  });
});

describe("every one of the 6 renderers calls the injected RedactFn before returning output (architecture §9.2, this session's DoD)", () => {
  const run = secretBearingRun();
  const redact = makeTestRedactor(SECRET_VALUE);
  const resolvedSecretRefs = new Set([SECRET_VALUE]);

  it("renderModelFacing redacts", () => {
    const out = JSON.stringify(renderModelFacing(run, redact, resolvedSecretRefs));
    expect(out).not.toContain(SECRET_VALUE);
  });
  it("renderMarkdown redacts", () => {
    expect(renderMarkdown(run, redact, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
  });
  it("renderHtml redacts", () => {
    expect(renderHtml(run, redact, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
  });
  it("renderPrComment redacts", () => {
    expect(renderPrComment(run, redact, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
  });
  it("renderJson redacts", () => {
    expect(renderJson(run, redact, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
  });
  it("renderCliText redacts", () => {
    expect(renderCliText(run, redact, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
  });

  it("confirms the fixture actually WOULD have leaked the secret through an identity (non-redacting) renderer — proving the test above is meaningful, not vacuously true", () => {
    const leaked = renderMarkdown(run, identityRedact, resolvedSecretRefs);
    expect(leaked).toContain(SECRET_VALUE);
  });
});

describe("markdown/HTML report UX ordering (spec §19.4): errors/failures render before the full trace section", () => {
  const run = fixtureRunRecord({
    status: "failed",
    trace: [{ seq: 0, stepId: "s1", block: "http.request", status: "failed", inputs: {}, error: "boom", startedAt: "t" }],
  });

  it("markdown: 'Failures' heading precedes 'Full trace' heading", () => {
    const md = renderMarkdown(run, identityRedact);
    expect(md.indexOf("## Failures")).toBeGreaterThan(-1);
    expect(md.indexOf("## Failures")).toBeLessThan(md.indexOf("## Full trace"));
  });

  it("html: Failures <h2> precedes Full trace <h2>", () => {
    const html = renderHtml(run, identityRedact);
    expect(html.indexOf("<h2>Failures</h2>")).toBeGreaterThan(-1);
    expect(html.indexOf("<h2>Failures</h2>")).toBeLessThan(html.indexOf("<h2>Full trace</h2>"));
  });

  it("html escapes run-derived text so it cannot break out of markup", () => {
    const maliciousRun = fixtureRunRecord({
      status: "failed",
      trace: [{ seq: 0, stepId: "s1", block: "http.request", status: "failed", inputs: {}, error: '<script>alert("xss")</script>', startedAt: "t" }],
    });
    const html = renderHtml(maliciousRun, identityRedact);
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderPrComment — spec §26.3 format", () => {
  it("matches the shape of the spec's own worked example", () => {
    const run = fixtureRunRecord({
      workflowId: "checkout-smoke",
      workflowVersion: "0.3.0",
      status: "completed",
      artifacts: [
        { id: "a1", runId: "r", name: "screenshot.png", kind: "screenshot", mime: "image/png", path: "p", bytes: 1, createdAt: "t" },
        { id: "a2", runId: "r", name: "console.json", kind: "console_log", mime: "application/json", path: "p", bytes: 1, createdAt: "t" },
        { id: "a3", runId: "r", name: "report.md", kind: "report", mime: "text/markdown", path: "p", bytes: 1, createdAt: "t" },
      ],
    });
    const comment = renderPrComment(run, identityRedact, new Set(), {
      workflowApprovalState: "draft",
      evalSummary: { suiteName: "browser-smoke", passed: 5, total: 5 },
      riskDiffLines: ["Added browser.click step", "No new secrets", "No command blocks"],
    });
    expect(comment).toContain("AART Verification Report");
    expect(comment).toContain("Workflow: checkout-smoke@0.3.0");
    expect(comment).toContain("Status: PASSED");
    expect(comment).toContain("Approval: draft");
    expect(comment).toContain("Eval suite: browser-smoke");
    expect(comment).toContain("Score: 5/5");
    expect(comment).toContain("- screenshot.png");
    expect(comment).toContain("- console.json");
    expect(comment).toContain("- report.md");
    expect(comment).toContain("Risk diff:");
    expect(comment).toContain("- Added browser.click step");
  });

  it("falls back to RunRecord.approved when workflowApprovalState is not supplied", () => {
    const comment = renderPrComment(fixtureRunRecord({ approved: false }), identityRedact);
    expect(comment).toContain("Approval: not approved");
  });

  it("bounds oversized outputs and points to the full RunRecord in PR comments", () => {
    const run = fixtureRunRecord({ outputs: { document: `start-${"x".repeat(200_000)}-end` } });
    const comment = renderPrComment(run, identityRedact);

    expect(comment.length).toBeLessThan(10_000);
    expect(comment).toContain("truncated-workflow-outputs");
    expect(comment).toContain(`"runId": "${run.runId}"`);
    expect(comment).not.toContain("-end");
  });
});

describe("renderJson — full-fidelity dump", () => {
  it("round-trips every top-level RunRecord field", () => {
    const run = fixtureRunRecord();
    const parsed = JSON.parse(renderJson(run, identityRedact));
    expect(parsed.runId).toBe(run.runId);
    expect(parsed.workflowId).toBe(run.workflowId);
    expect(parsed.trace).toHaveLength(run.trace.length);
  });
});

describe("renderCliText", () => {
  it("summarizes headline, approval, trigger, and step/failure counts compactly", () => {
    const run = fixtureRunRecord({ status: "failed", trace: [{ seq: 0, stepId: "s1", block: "http.request", status: "failed", inputs: {}, error: "boom", startedAt: "t" }] });
    const text = renderCliText(run, identityRedact);
    expect(text).toContain("FAILED");
    expect(text).toContain("s1 (http.request): boom");
  });
});

describe("createReportRenderers — composition-root DI factory", () => {
  it("binds every renderer to the injected RedactFn", () => {
    const run = secretBearingRun();
    const redact = makeTestRedactor(SECRET_VALUE);
    const renderers = createReportRenderers(redact);
    const resolvedSecretRefs = new Set([SECRET_VALUE]);

    expect(JSON.stringify(renderers.modelFacing(run, resolvedSecretRefs))).not.toContain(SECRET_VALUE);
    expect(renderers.markdown(run, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
    expect(renderers.html(run, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
    expect(renderers.prComment(run, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
    expect(renderers.json(run, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
    expect(renderers.cliText(run, resolvedSecretRefs)).not.toContain(SECRET_VALUE);
  });
});
