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
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { compileWorkflowInput, YamlCompileError } from "../yaml-compiler.js";

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
        return { ok: false, error: err.message, findings: (err.issues ?? []).map((i) => ({ class: "schema", path: "", message: i, severity: "error" })) };
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
  return { ok: true, workflowId: draft.id, workflowVersion: draft.version, approval: draft.approval };
}
