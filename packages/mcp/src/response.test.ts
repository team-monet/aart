// Result-affordance envelope tests — architecture §10.2/§32.2c. DoD: "every
// tool's result includes a correct next field for both success AND failure
// paths" — tested here as a completeness sweep over all 26 tools (the
// original 21 + D1's aart_deploy, AMENDMENTS.md A56 + D2b's four
// aart_remote_* read tools, AMENDMENTS.md, this session) x 2 outcomes (52
// checks), plus the exact worked example architecture §10.2 itself cites
// verbatim.
import { describe, expect, it } from "vitest";
import { computeNext, TOOL_NAMES, TOOL_TIERS, wrapResult } from "./response.js";

describe("TOOL_NAMES / TOOL_TIERS — architecture §10.1's 21-tool catalog + D1's aart_deploy (AMENDMENTS.md A56) + D2b's four aart_remote_* tools (AMENDMENTS.md, this session)", () => {
  it("has exactly 26 tools", () => {
    expect(TOOL_NAMES).toHaveLength(26);
  });

  it("has exactly 10 core and 16 extended tools (spec Fix C's 10/11 split, +1 extended for D1's aart_deploy, +4 extended for D2b's aart_remote_* tools)", () => {
    const core = TOOL_NAMES.filter((t) => TOOL_TIERS[t] === "core");
    const extended = TOOL_NAMES.filter((t) => TOOL_TIERS[t] === "extended");
    expect(core).toHaveLength(10);
    expect(extended).toHaveLength(16);
  });

  it("marks aart_approve as core", () => {
    expect(TOOL_TIERS.aart_approve).toBe("core");
  });

  it("contains every tool name from architecture §34's flat list plus D1's aart_deploy plus D2b's four aart_remote_* tools, no more no less", () => {
    const expected = [
      "aart_find_blocks",
      "aart_get_block",
      "aart_validate",
      "aart_register_block",
      "aart_run_workflow",
      "aart_get_report",
      "aart_verify",
      "aart_approve",
      "aart_request_approval",
      "aart_record_correction",
      "aart_list_blocks",
      "aart_get_schema",
      "aart_propose_workflow",
      "aart_diff_workflow",
      "aart_create_eval_from_correction",
      "aart_run_eval",
      "aart_promote_workflow",
      "aart_deploy_workflow",
      "aart_deploy",
      "aart_trigger_workflow",
      "aart_list_waiting_runs",
      "aart_resume_run",
      "aart_remote_status",
      "aart_remote_why",
      "aart_remote_runs",
      "aart_remote_run",
    ].sort();
    expect([...TOOL_NAMES].sort()).toEqual(expected);
  });
});

describe("computeNext — every tool has a non-empty next for both success and failure", () => {
  for (const tool of TOOL_NAMES) {
    it(`${tool}: success`, () => {
      const next = computeNext(tool, "success");
      expect(typeof next).toBe("string");
      expect(next.length).toBeGreaterThan(0);
    });
    it(`${tool}: failure`, () => {
      const next = computeNext(tool, "failure");
      expect(typeof next).toBe("string");
      expect(next.length).toBeGreaterThan(0);
    });
  }

  it("success and failure next differ for every tool (a real branch, not a static string)", () => {
    for (const tool of TOOL_NAMES) {
      expect(computeNext(tool, "success")).not.toBe(computeNext(tool, "failure"));
    }
  });
});

describe("wrapResult — the shared envelope (architecture §10.2's [DECISION])", () => {
  it("spreads the handler result and appends `next` — the exact worked example architecture §10.2/§32.2c cites", () => {
    const wrapped = wrapResult("aart_register_block", { ok: true, workflowId: "wf", workflowVersion: "0.1.0" });
    expect(wrapped).toEqual({ ok: true, workflowId: "wf", workflowVersion: "0.1.0", next: "Draft registered. Next: `aart_validate`." });
  });

  it("picks the failure branch when ok is false", () => {
    const wrapped = wrapResult("aart_validate", { ok: false, error: "boom" });
    expect(wrapped.next).toBe(computeNext("aart_validate", "failure"));
  });

  it("picks the success branch when ok is true", () => {
    const wrapped = wrapResult("aart_validate", { ok: true, valid: true, findings: [] });
    expect(wrapped.next).toBe(computeNext("aart_validate", "success"));
  });

  it("never mutates the input result object", () => {
    const input = { ok: true as const };
    const wrapped = wrapResult("aart_verify", input);
    expect(input).not.toHaveProperty("next");
    expect(wrapped).not.toBe(input);
  });
});
