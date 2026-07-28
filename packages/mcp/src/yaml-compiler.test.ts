// YAML uses/with compiler tests — architecture §2.3/§10.3.
//
// The headline test compiles spec §14.2's example VERBATIM (the exact YAML
// block reproduced below, character for character against the spec text)
// as a fixture, and checks the result against the REAL WorkflowSchema —
// this is the single most direct spec-fidelity test available (this
// session's own DoD note, and implementation plan P46/P48's corrected
// framing): the spec prints the before-YAML in full and asserts compilation
// "to canonical format," but never prints the after-object — this test
// derives that after-object and validates it against the real Zod schema,
// rather than against a second printed fixture that doesn't exist in the
// spec.
import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@aart/types";
import { compileWorkflowInput, compileWorkflowObject, compileYamlWorkflow, YamlCompileError } from "./yaml-compiler.js";

// Verbatim from aart_product_spec_v2.md §14.2 (lines 999-1028).
const SPEC_14_2_EXAMPLE = `id: checkout-smoke
name: Checkout Smoke Test
version: 0.1.0

inputs:
  url:
    type: string
    required: true

steps:
  - id: open
    uses: browser.goto
    with:
      url: "{{ inputs.url }}"

  - id: read
    uses: web.read

  - id: assert
    uses: assert.contains
    with:
      value: "{{ steps.read.outputs.text }}"
      expected: "Checkout"

  - id: screenshot
    uses: browser.screenshot
    with:
      name: checkout
`;

describe("compileYamlWorkflow — spec §14.2's exact example, verbatim fixture", () => {
  it("compiles to a result that validates against the real, frozen WorkflowSchema", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    const reparsed = WorkflowSchema.safeParse(compiled);
    expect(reparsed.success).toBe(true);
  });

  it("derives the exact canonical shape the spec's before-YAML implies (id/name/version passthrough)", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    expect(compiled.id).toBe("checkout-smoke");
    expect(compiled.name).toBe("Checkout Smoke Test");
    expect(compiled.version).toBe("0.1.0");
  });

  it("compiles the keyed-object inputs: -> Field[] per architecture §2.3's [DECISION] (key becomes Field.name)", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    expect(compiled.inputs).toEqual([{ name: "url", type: "string", required: true }]);
  });

  it("defaults outputs to [] when the sugar form declares none", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    expect(compiled.outputs).toEqual([]);
  });

  it("wraps the flat steps: array into execution.type=workflow / execution.steps", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    expect(compiled.execution.type).toBe("workflow");
    expect(compiled.execution.steps).toHaveLength(4);
    expect(compiled.execution.steps.map((s) => s.id)).toEqual(["open", "read", "assert", "screenshot"]);
  });

  it("preserves uses/with verbatim on every step (already-canonical field names)", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    expect(compiled.execution.steps[0]).toMatchObject({ id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } });
    expect(compiled.execution.steps[1]).toMatchObject({ id: "read", uses: "web.read" });
    expect(compiled.execution.steps[2]).toMatchObject({
      id: "assert",
      uses: "assert.contains",
      with: { value: "{{ steps.read.outputs.text }}", expected: "Checkout" },
    });
    expect(compiled.execution.steps[3]).toMatchObject({ id: "screenshot", uses: "browser.screenshot", with: { name: "checkout" } });
  });

  it("defaults approval to draft and gates to all-pending when the sugar form declares neither", () => {
    const compiled = compileYamlWorkflow(SPEC_14_2_EXAMPLE);
    expect(compiled.approval).toBe("draft");
    expect(compiled.gates).toEqual({ validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" });
  });
});

describe("compileYamlWorkflow — additional coverage beyond the spec fixture", () => {
  it("rejects YAML that doesn't parse to a mapping", () => {
    expect(() => compileYamlWorkflow("- just\n- a\n- list\n")).toThrow(YamlCompileError);
  });

  it("rejects malformed YAML syntax", () => {
    expect(() => compileYamlWorkflow("id: [unterminated\n")).toThrow(YamlCompileError);
  });

  it("requires a top-level steps array (or execution.steps)", () => {
    expect(() => compileYamlWorkflow("id: x\nname: X\nversion: 0.1.0\n")).toThrow(/steps/);
  });

  it("rejects an invalid {{ }} expression with a clear, actionable message (errors-as-corrections, spec §32.2b)", () => {
    const badYaml = `id: bad
name: Bad
version: 0.1.0
steps:
  - id: s1
    uses: http.request
    with:
      url: "{{ inputs.url + 1 }}"
`;
    expect(() => compileYamlWorkflow(badYaml)).toThrow(YamlCompileError);
    try {
      compileYamlWorkflow(badYaml);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(YamlCompileError);
      expect((err as YamlCompileError).message).toMatch(/operators are not supported/);
    }
  });

  it("finds an invalid expression nested inside a step's with: object (not just top-level string values)", () => {
    const badYaml = `id: bad2
name: Bad2
version: 0.1.0
steps:
  - id: s1
    uses: http.request
    with:
      method: GET
      url: "https://example.com"
      headers:
        Authorization: "{{ secrets.TOKEN == 1 }}"
`;
    expect(() => compileYamlWorkflow(badYaml)).toThrow(/operators are not supported/);
  });

  it("rejects an invalid public outputMapping expression before registration", () => {
    const badYaml = `id: bad-output
name: Bad Output
version: 0.1.0
outputs:
  result:
    type: string
    required: true
steps:
  - id: read
    uses: web.read
outputMapping:
  result: "{{ steps.read.outputs.text + 1 }}"
`;
    expect(() => compileYamlWorkflow(badYaml)).toThrow(/outputMapping "result".*operators are not supported/s);
  });

  it("rejects an unmatched public outputMapping delimiter before registration", () => {
    const badYaml = `id: bad-output-delimiter
name: Bad Output Delimiter
version: 0.1.0
outputs:
  result:
    type: string
    required: true
steps:
  - id: read
    uses: web.read
outputMapping:
  result: "{{ steps.read.outputs.text"
`;
    expect(() => compileYamlWorkflow(badYaml)).toThrow(/outputMapping "result".*unmatched expression delimiter.*"\{\{"/s);
  });

  it("rejects an unmatched expression delimiter inside a step value", () => {
    const badYaml = `id: bad-step-delimiter
name: Bad Step Delimiter
version: 0.1.0
steps:
  - id: read
    uses: web.read
    with:
      url: "https://example.com/}}"
`;
    expect(() => compileYamlWorkflow(badYaml)).toThrow(/step "read".*unmatched expression delimiter.*"\}\}"/s);
  });

  it("rejects a required declared output with no outputMapping entry", () => {
    expect(() =>
      compileYamlWorkflow(`id: missing-output
name: Missing Output
version: 0.1.0
outputs:
  result:
    type: string
    required: true
steps:
  - id: read
    uses: web.read
`),
    ).toThrow(/required output "result" has no outputMapping entry/);
  });

  it("rejects an outputMapping field that is not part of the declared public outputs", () => {
    expect(() =>
      compileYamlWorkflow(`id: extra-output
name: Extra Output
version: 0.1.0
steps:
  - id: read
    uses: web.read
outputMapping:
  result: "{{ steps.read.outputs.text }}"
`),
    ).toThrow(/outputMapping "result" is not declared in outputs/);
  });

  it("accepts a well-formed secrets.* expression", () => {
    const yamlSource = `id: with-secret
name: With Secret
version: 0.1.0
steps:
  - id: s1
    uses: http.request
    with:
      url: "https://example.com"
      headers:
        Authorization: "{{ secrets.TOKEN }}"
`;
    expect(() => compileYamlWorkflow(yamlSource)).not.toThrow();
  });

  it("round-trips an already-canonical object (execution.steps form) unchanged in shape", () => {
    const canonical = {
      id: "already-canonical",
      name: "Already Canonical",
      version: "0.1.0",
      inputs: [{ name: "x", type: "string" }],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.sleep", with: { ms: 10 } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    const compiled = compileWorkflowObject(canonical);
    expect(compiled.approval).toBe("approved");
    expect(compiled.execution.steps).toHaveLength(1);
  });

  it("compileWorkflowInput accepts a YAML string", () => {
    const compiled = compileWorkflowInput(SPEC_14_2_EXAMPLE);
    expect(compiled.id).toBe("checkout-smoke");
  });

  it("compileWorkflowInput accepts an already-parsed sugar-shaped object", () => {
    const compiled = compileWorkflowInput({
      id: "obj-form",
      name: "Object Form",
      version: "0.1.0",
      inputs: { n: { type: "number", required: true, default: 1 } },
      steps: [{ id: "s1", uses: "flow.sleep", with: { ms: "{{ inputs.n }}" } }],
    });
    expect(compiled.inputs).toEqual([{ name: "n", type: "number", required: true, default: 1 }]);
  });

  it("compileWorkflowInput rejects a non-string, non-object input", () => {
    expect(() => compileWorkflowInput(42)).toThrow(YamlCompileError);
  });

  it("rejects a compiled shape that still fails the real WorkflowSchema (e.g. non-string id)", () => {
    expect(() =>
      compileWorkflowObject({ id: 123, name: "Bad Id", version: "0.1.0", steps: [{ id: "s1", uses: "flow.sleep" }] }),
    ).toThrow(YamlCompileError);
  });
});
