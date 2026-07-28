import type { Field, Workflow, WorkflowStep } from "@aart/types";
import { describe, expect, it } from "vitest";
import type { CapabilityClosureLookup } from "../capability.js";
import { findEffectfulStepsWithoutIdempotencyKey, validateInputSafety } from "./input-safety.js";

function field(overrides: Partial<Field>): Field {
  return { name: "f", type: "string", ...overrides };
}

function wf(
  inputs: Field[],
  steps: WorkflowStep[],
  outputs: Field[] = [],
  outputMapping?: Record<string, string>,
): Pick<Workflow, "inputs" | "outputs" | "execution"> {
  return { inputs, outputs, execution: { type: "workflow", steps, outputMapping } };
}

const lookup: CapabilityClosureLookup = {
  resolve(blockId) {
    switch (blockId) {
      case "command.run":
        return { kind: "block", capabilities: ["command"] };
      case "email.send":
        return { kind: "block", capabilities: ["email.send"] };
      case "file.write":
        return { kind: "block", capabilities: ["file.write"] };
      case "browser.goto":
        return { kind: "block", capabilities: ["browser"] };
      case "assert.contains":
        return { kind: "block", capabilities: [] };
      default:
        return undefined;
    }
  },
};

describe("validateInputSafety — enum/regex/default consistency (spec §18.4)", () => {
  it("flags a default value outside its declared enum", () => {
    const findings = validateInputSafety(wf([field({ enum: ["a", "b"], default: "c" })], []), lookup);
    expect(findings.some((f) => f.class === "input-safety" && f.severity === "error" && f.message.includes("default"))).toBe(true);
  });

  it("passes a default value that IS within its enum", () => {
    const findings = validateInputSafety(wf([field({ enum: ["a", "b"], default: "a" })], []), lookup);
    expect(findings).toEqual([]);
  });

  it("flags a default that doesn't match its declared pattern", () => {
    const findings = validateInputSafety(wf([field({ pattern: "^[0-9]+$", default: "abc" })], []), lookup);
    expect(findings.some((f) => f.message.includes("pattern"))).toBe(true);
  });

  it("passes a default that DOES match its declared pattern", () => {
    const findings = validateInputSafety(wf([field({ pattern: "^[0-9]+$", default: "123" })], []), lookup);
    expect(findings).toEqual([]);
  });

  it("flags an invalid regex pattern itself", () => {
    const findings = validateInputSafety(wf([field({ pattern: "(unterminated", default: "x" })], []), lookup);
    expect(findings.some((f) => f.message.includes("not a valid regular expression"))).toBe(true);
  });

  it("validates output field patterns as part of the public result contract", () => {
    const findings = validateInputSafety(wf([], [], [field({ name: "result", pattern: "(unterminated" })]), lookup);
    expect(findings).toContainEqual(expect.objectContaining({ path: "outputs[0].pattern", severity: "error" }));
  });

  it("rejects a pattern on a non-string workflow output before execution", () => {
    const findings = validateInputSafety(wf([], [], [field({ name: "count", type: "number", pattern: "^\\d+$" })]), lookup);
    expect(findings).toContainEqual(
      expect.objectContaining({ path: "outputs[0].pattern", severity: "error", message: expect.stringContaining("non-string") }),
    );
  });

  it("allows a pattern on an opaque custom string-like workflow output", () => {
    const findings = validateInputSafety(
      wf([], [], [field({ name: "publishedAt", type: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })]),
      lookup,
    );
    expect(findings).toEqual([]);
  });

  it("rejects duplicate workflow output declarations", () => {
    const findings = validateInputSafety(
      wf([], [], [field({ name: "result" }), field({ name: "result", type: "number" })]),
      lookup,
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ path: "outputs[1].name", severity: "error", message: expect.stringContaining("more than once") }),
    );
  });

  it("rejects a required output with no mapping in the canonical governance gate", () => {
    const findings = validateInputSafety(wf([], [], [field({ name: "result", required: true })]), lookup);

    expect(findings).toContainEqual(
      expect.objectContaining({
        path: "execution.outputMapping.result",
        severity: "error",
        message: expect.stringContaining('Required output "result" has no outputMapping entry'),
      }),
    );
  });

  it("rejects a mapping that publishes an undeclared output in the canonical governance gate", () => {
    const findings = validateInputSafety(
      wf([], [], [field({ name: "declared" })], { undeclared: "{{ inputs.value }}" }),
      lookup,
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        path: "execution.outputMapping.undeclared",
        severity: "error",
        message: expect.stringContaining('outputMapping "undeclared" is not declared in outputs'),
      }),
    );
  });
});

describe("validateInputSafety — no unsafe interpolation into command binaries (spec §18.4, command.run specifically)", () => {
  it("flags a literal shell metacharacter in a command.run step's with: block", () => {
    const findings = validateInputSafety(
      wf([], [{ id: "run", uses: "command.run", with: { args: ["; rm -rf /"] } }]),
      lookup,
    );
    expect(findings.some((f) => f.severity === "error" && f.message.includes("shell metacharacter"))).toBe(true);
  });

  it("does NOT flag shell metacharacters embedded inside a {{ }} expression's own text — @aart/expr's grammar already disallows operators there", () => {
    // command.run with no idempotencyKey still legitimately triggers the
    // separate class-4 idempotencyKey WARNING (tested on its own below) —
    // this test only asserts the shell-metacharacter check specifically
    // stays silent on expression-only content.
    const findings = validateInputSafety(
      wf([], [{ id: "run", uses: "command.run", with: { arg: "{{ steps.prior.outputs.value }}" }, idempotencyKey: "{{ run.id }}" }]),
      lookup,
    );
    expect(findings).toEqual([]);
  });

  it("does NOT flag shell metacharacters in a non-command.run step (this check is command.run-specific per the implementation plan)", () => {
    const findings = validateInputSafety(
      wf([], [{ id: "open", uses: "browser.goto", with: { url: "https://example.com?a=1&b=2" } }]),
      lookup,
    );
    expect(findings.some((f) => f.message.includes("shell metacharacter"))).toBe(false);
  });

  it("tests EVERY named dangerous shell metacharacter class (;|`$(){}<>*?~!#) at least once", () => {
    const dangerousSamples = [";", "|", "`", "$(", ")", "{", "}", "<", ">", "*", "?", "~", "!", "#"];
    for (const sample of dangerousSamples) {
      const findings = validateInputSafety(wf([], [{ id: "run", uses: "command.run", with: { arg: `safe${sample}unsafe` } }]), lookup);
      expect(findings.some((f) => f.message.includes("shell metacharacter"))).toBe(true);
    }
  });
});

describe("validateInputSafety — secrets referenced correctly (spec §18.4)", () => {
  it("flags (as a WARNING, not a hard error) a secret-shaped literal in with: instead of a {{ secrets.NAME }} reference", () => {
    const findings = validateInputSafety(
      wf([], [{ id: "call", uses: "browser.goto", with: { headers: { authorization: "sk-live-abcdefghijklmnopqrstuvwx" } } }]),
      lookup,
    );
    const found = findings.find((f) => f.message.includes("secret-shaped"));
    expect(found).toBeDefined();
    expect(found?.severity).toBe("warning");
  });

  it("does not flag a properly-referenced secret via {{ secrets.NAME }}", () => {
    const findings = validateInputSafety(
      wf([], [{ id: "call", uses: "browser.goto", with: { headers: { authorization: "{{ secrets.GITHUB_TOKEN }}" } } }]),
      lookup,
    );
    expect(findings.some((f) => f.message.includes("secret-shaped"))).toBe(false);
  });
});

describe("findEffectfulStepsWithoutIdempotencyKey / the class-4 WARNING (architecture §4.2/§7.7)", () => {
  it("flags an effectful-capability step with no idempotencyKey", () => {
    const flagged = findEffectfulStepsWithoutIdempotencyKey([{ id: "send", uses: "email.send" }], lookup);
    expect(flagged).toEqual(["send"]);
  });

  it("does not flag an effectful step that DOES declare idempotencyKey", () => {
    const flagged = findEffectfulStepsWithoutIdempotencyKey(
      [{ id: "send", uses: "email.send", idempotencyKey: "{{ run.id }}:send" }],
      lookup,
    );
    expect(flagged).toEqual([]);
  });

  it("does not flag a non-effectful step (e.g. assert.contains) regardless of idempotencyKey", () => {
    const flagged = findEffectfulStepsWithoutIdempotencyKey([{ id: "check", uses: "assert.contains" }], lookup);
    expect(flagged).toEqual([]);
  });

  it("covers command and file.write as effectful capabilities too", () => {
    expect(findEffectfulStepsWithoutIdempotencyKey([{ id: "run", uses: "command.run" }], lookup)).toEqual(["run"]);
    expect(findEffectfulStepsWithoutIdempotencyKey([{ id: "write", uses: "file.write" }], lookup)).toEqual(["write"]);
  });

  it("does not flag a step whose block resolves to a composed workflow (nested idempotency is that workflow's own concern)", () => {
    const nestedLookup: CapabilityClosureLookup = {
      resolve: (id) => (id === "composed.thing" ? { kind: "workflow", steps: [] } : undefined),
    };
    expect(findEffectfulStepsWithoutIdempotencyKey([{ id: "s", uses: "composed.thing" }], nestedLookup)).toEqual([]);
  });

  it("the WARNING appears in validateInputSafety's overall findings with severity 'warning', never blocking validation from otherwise passing", () => {
    const findings = validateInputSafety(wf([], [{ id: "send", uses: "email.send" }]), lookup);
    const warning = findings.find((f) => f.message.includes("idempotencyKey"));
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
  });
});
