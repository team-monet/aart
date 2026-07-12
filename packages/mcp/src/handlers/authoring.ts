// Authoring handlers — aart_validate, aart_register_block.
//
// aart_register_block's literal name notwithstanding, its documented
// behavior ("Draft registered. Next: aart_validate." — architecture §10.2's
// own worked example) and the v0.x prototype's identical-in-spirit
// aa_register_block ("Register. Call aa_register_block. It saves as
// draft.", /Users/johnlee/code/aa-runtime/src/agent/guide.ts) both confirm
// this tool registers a WORKFLOW draft, not a block implementation —
// registering a workflow additionally makes it dispatchable as a
// `workflow`-type block from other workflows (block-type dispatch for
// node/command/connector/native/workflow is uniform, per S1's SEAMS.md Seam
// 6), which is presumably the origin of the tool's name.
import { WorkflowSchema } from "@aart/types";
import { recordEvent } from "@aart/store";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { compileWorkflowInput, YamlCompileError } from "../yaml-compiler.js";
import { applyGateResult } from "./governance.js";

const DRAFT_GATES = {
  validate: "pending",
  readiness: "pending",
  evals: "pending",
  riskReview: "pending",
  humanReview: "pending",
} as const;

export interface ValidateWorkflowInput {
  /** A draft workflow (YAML/JSON source text, sugar OR canonical object) to validate in-place. */
  workflow?: unknown;
  /** OR: validate an already-registered version by reference. */
  workflowId?: string;
  workflowVersion?: string;
}

export async function validateWorkflowHandler(ctx: AartContext, input: ValidateWorkflowInput): Promise<HandlerResult> {
  let workflow: unknown;
  if (input.workflow !== undefined) {
    try {
      workflow = compileWorkflowInput(input.workflow);
    } catch (err) {
      if (err instanceof YamlCompileError) {
        // A compile failure (can't even reach a Workflow shape to check
        // against the schema) is itself a class-1 (schema) validation
        // finding — always at least one, falling back to the top-level
        // compile error message when the compiler didn't itself produce a
        // per-field issues[] breakdown (e.g. a missing top-level "steps").
        const issues = err.issues.length > 0 ? err.issues : [err.message];
        return {
          ok: false,
          valid: false,
          error: err.message,
          findings: issues.map((i) => ({ class: "schema", path: "", message: i, severity: "error" })),
        };
      }
      throw err;
    }
  } else if (input.workflowId && input.workflowVersion) {
    const stored = await ctx.store.workflows.get(input.workflowId, input.workflowVersion);
    if (!stored) return { ok: false, error: `Workflow ${input.workflowId}@${input.workflowVersion} not found.` };
    workflow = stored;
  } else {
    return { ok: false, error: "Provide either `workflow` (a draft) or `workflowId`+`workflowVersion` (a registered version)." };
  }

  const result = ctx.governance.validateWorkflow(workflow);

  // Gate write (S14 "gate write paths", the dead branch A45 found wired for
  // real): ONLY the workflowId+workflowVersion (already-registered) shape
  // writes gates.validate — a draft/in-memory `workflow` validation has no
  // persisted version to attribute a gate to, spec §17.1's "validate" gate
  // being a fact about a specific VERSION, not about arbitrary source text.
  // `result.valid` already means exactly "zero error-class findings"
  // (isValid, validation/types.ts: `findings.every(f => f.severity !==
  // "error")`) — a clean run per this session's own brief, warnings
  // included, don't block. A run WITH errors writes "failed" (chosen over
  // reverting to "pending": "failed" is strictly more informative — it
  // shows up in `unmetGates`/gate introspection identically either way, but
  // unlike "pending" it also records that a check genuinely ran and did not
  // pass, not merely "never checked" — symmetric with how this session's
  // evals writer treats a below-threshold score).
  if (input.workflowId && input.workflowVersion) {
    const gateWrite = await applyGateResult(ctx, input.workflowId, input.workflowVersion, "validate", result.valid ? "passed" : "failed");
    if (gateWrite.ok) {
      return { ok: result.valid, valid: result.valid, findings: result.findings, gates: gateWrite.gates, approval: gateWrite.approval };
    }
  }

  return { ok: result.valid, valid: result.valid, findings: result.findings };
}

export interface RegisterWorkflowInput {
  /** YAML/JSON source text (sugar or canonical) OR an already-parsed object. */
  workflow: unknown;
}

export async function registerWorkflowHandler(ctx: AartContext, input: RegisterWorkflowInput): Promise<HandlerResult> {
  let compiled;
  try {
    compiled = compileWorkflowInput(input.workflow);
  } catch (err) {
    if (err instanceof YamlCompileError) return { ok: false, error: err.message };
    throw err;
  }

  // Every registration lands as a fresh draft (spec's own v0.x-validated
  // "Register ... saves as draft" behavior) — computeApprovalState (the
  // governance state machine's SOLE writer of `approval`, architecture
  // §7.1) is what ever moves it past "draft", never registration itself.
  const draft = WorkflowSchema.parse({ ...compiled, approval: "draft", gates: DRAFT_GATES });
  await ctx.store.workflows.put(draft);
  await recordEvent(
    ctx.store,
    { type: "workflow.version_registered", workflowId: draft.id, workflowVersion: draft.version, summary: `${draft.id}@${draft.version} registered` },
    ctx.now,
  );
  return { ok: true, workflowId: draft.id, workflowVersion: draft.version, approval: draft.approval };
}
