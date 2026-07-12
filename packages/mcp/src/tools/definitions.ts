// Tool definitions — name, tier, model-facing description, Zod input
// schema. Descriptions follow architecture §32.2(a)'s pattern: "answer
// when-to-use, why, and consequence-of-skipping" — not just what the tool
// does. Canonical example the pattern is built from: "Shell runs and is
// forgotten. AART runs and is kept."
import { z } from "zod";
import type { ToolName, ToolTier } from "../response.js";
import { TOOL_TIERS } from "../response.js";

export interface ToolDefinition {
  name: ToolName;
  tier: ToolTier;
  description: string;
  inputSchema: z.ZodType;
}

const signalSchema = z.object({ name: z.string(), correlationId: z.string(), payload: z.unknown().optional() });

const DESCRIPTIONS: Record<ToolName, string> = {
  aart_find_blocks:
    "Search the block catalog by keyword or category before you compose a step. Reach for this FIRST when you need a capability — reusing an existing block is always preferable to authoring new logic, and a block you didn't know existed is a block you'll otherwise reinvent badly.",
  aart_get_block:
    "Get one block's exact manifest (input/output JSON Schema, capabilities, description) by id. Call this before wiring a step's `with:` — guessing a block's input shape is exactly the kind of thing that fails validation and costs a corrective round-trip.",
  aart_validate:
    "Validate a draft workflow (or an already-registered version) against AART's 5-class validation engine (schema, references, capabilities, input safety, deployment readiness). Every finding includes what's wrong and, where possible, a corrected snippet — fix errors (warnings never block) and call this again before running. Skipping this and going straight to aart_run_workflow just moves the same failure later, with less context to fix it.",
  aart_register_block:
    "Save a drafted workflow to the registry as a new version (status: draft). This is what turns a workflow you composed in this conversation into a durable, versioned, re-runnable asset instead of something that evaporates when the chat ends — 'Shell runs and is forgotten. AART runs and is kept.'",
  aart_run_workflow:
    "Execute a registered workflow by id and get back a run record (status, outputs, per-step trace). This is how a draft actually proves itself — call aart_validate first so a run failure means something real broke, not a shape you could have caught earlier.",
  aart_get_report:
    "Fetch the full evidence report for a run — the model-facing summary (headline, failures, artifact references) or a human-readable markdown rendering. Treat this as the source of truth for whether something worked; never claim a run succeeded without having read its report.",
  aart_verify:
    "One-shot verify: give it a URL (and optionally what you expect to see) and get back a real evidence report — page loaded, text checked, screenshot captured. This is the easiest way to actually SEE whether something works before you say it does, instead of assuming from reading code. Before you claim the app works, call this.",
  aart_approve:
    "Record a human's approval decision exactly as they stated it in this conversation. NEVER call this without the user having explicitly said yes to what you showed them (aart_request_approval's summary) — this tool exists to capture a real decision, not to unblock yourself. Not available in strict/production trust modes; approval there only happens via the CLI or dashboard, out of this chat.",
  aart_request_approval:
    "Create an approval request — for a specific run's paused human.approval step, or for a whole workflow version ahead of promotion — and present its summary to the user. The agent can never self-approve: this only creates the request, it never decides it.",
  aart_record_correction:
    "Capture a human-supplied correction to a run's output (observed value -> corrected value, with a reason). The human remains the author of record even when you transcribe it for them. A recorded correction can become a regression test via aart_create_eval_from_correction — the mistake, once caught, doesn't get to happen again silently.",
  aart_list_blocks:
    "List the full block catalog, optionally filtered by category. Use aart_find_blocks instead when you already know roughly what you're looking for — this is for browsing the whole surface.",
  aart_get_schema:
    "Get the canonical JSON Schema for the Workflow type itself, or for one block's input/output shape. Use this when you need the exact, authoritative shape rather than inferring it from an example.",
  aart_propose_workflow:
    "Match your request against AART's built-in recipe catalog and get back a ready-to-instantiate workflow skeleton. Does not call an LLM — it's a lookup, not a generation. Models are reliably good at filling in a skeleton and reliably weak at composing a multi-step workflow from raw blocks with no scaffold, so check here before you compose from scratch.",
  aart_diff_workflow:
    "Compute the semantic risk diff between two versions of the same workflow — which steps were added/removed/modified, and whether risk increased. Use this before promoting a changed version so the approval decision is about what actually changed, not a wall of JSON.",
  aart_create_eval_from_correction:
    "Turn a recorded correction into a permanent eval example (input -> the corrected expected output) inside a suite. This is how a one-off human fix becomes a standing regression check instead of a mistake that can silently recur next time the workflow runs.",
  aart_run_eval:
    "Run every example in an eval suite against a workflow version and record the pass/fail/regression result. Do this before promoting a workflow whose changes could plausibly regress a prior fix — a version that looks right by inspection can still fail a case a human already corrected once.",
  aart_promote_workflow:
    "Recompute and, if every required gate has passed or been waived, advance a workflow version's approval to 'approved'. Refuses (and tells you which gates are unmet) rather than approving partially — there is no partial promotion.",
  aart_deploy_workflow:
    "Deploy an approved workflow version to a named environment, creating the Deployment record a trigger can bind against. Refuses if the version isn't promoted for that environment's required gates — deploying is not a way around promotion.",
  aart_deploy:
    "Push a workflow version to a REMOTE aart server over HTTP — the one-command alternative to producing a bundle and copying it by hand. Bundles the version, sends it to the named remote's own configured environment (aart remote add sets this — it's a property of the remote, not something you choose per call), and ingests it there. Pass plan:true first to preview what would happen (gate status, whether triggers would go live) with zero writes on the remote before committing for real. Distinct from aart_deploy_workflow, which promotes a version into a LOCAL environment record — this ships bytes to a different, possibly remote, aart server entirely.",
  aart_trigger_workflow:
    "Trigger a run of a workflow that's actually deployed, or deliver a signal to resume a run waiting on one. Use aart_run_workflow instead for ad hoc/local runs of a workflow that isn't deployed anywhere yet.",
  aart_list_waiting_runs:
    "List every run currently paused on a wait (signal, timer, webhook, external job, queue, manual, or human approval). Check this before assuming a long-running workflow died — a 'waiting' run is durable and expected to still be there.",
  aart_resume_run:
    "Resume a specific waiting run — with a direct payload, or by delivering a matching signal. Call aart_list_waiting_runs first if you don't already know exactly which run/step is waiting.",
};

const inputSchemas: Record<ToolName, z.ZodType> = {
  aart_find_blocks: z.object({ query: z.string(), category: z.string().optional() }),
  aart_get_block: z.object({ id: z.string() }),
  aart_validate: z.object({
    workflow: z.unknown().optional(),
    workflowId: z.string().optional(),
    workflowVersion: z.string().optional(),
  }),
  aart_register_block: z.object({ workflow: z.unknown() }),
  aart_run_workflow: z.object({
    workflowId: z.string(),
    workflowVersion: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    dryRun: z.boolean().optional(),
  }),
  aart_get_report: z.object({ runId: z.string(), format: z.enum(["model", "markdown"]).optional() }),
  aart_verify: z.object({ url: z.string(), expect: z.string().optional() }),
  aart_approve: z.object({ taskId: z.string(), decision: z.enum(["approved", "rejected", "needs_changes"]), reviewer: z.string() }),
  aart_request_approval: z.object({
    runId: z.string().optional(),
    stepId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowVersion: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  }),
  aart_record_correction: z.object({
    runId: z.string(),
    stepId: z.string(),
    fieldPath: z.string(),
    observed: z.unknown(),
    corrected: z.unknown(),
    reason: z.string(),
    reviewer: z.string(),
  }),
  aart_list_blocks: z.object({ category: z.string().optional() }),
  aart_get_schema: z.object({ kind: z.enum(["workflow", "block"]), blockId: z.string().optional() }),
  aart_propose_workflow: z.object({ request: z.string() }),
  aart_diff_workflow: z.object({ workflowId: z.string(), fromVersion: z.string(), toVersion: z.string() }),
  aart_create_eval_from_correction: z.object({ runId: z.string(), stepId: z.string(), fieldPath: z.string().optional(), suiteId: z.string() }),
  aart_run_eval: z.object({ suiteId: z.string(), workflowId: z.string(), workflowVersion: z.string().optional() }),
  aart_promote_workflow: z.object({ workflowId: z.string(), workflowVersion: z.string() }),
  aart_deploy_workflow: z.object({ workflowId: z.string(), workflowVersion: z.string(), target: z.string() }),
  // D1 "remotes + push" (AMENDMENTS.md A56). workflowVersion is REQUIRED
  // (not defaulted to "latest") — matching aart_deploy_workflow's own
  // established convention above: the shared handler (deployToRemoteHandler)
  // takes a required version; CLI's `aart push` resolves "latest" itself
  // before calling it (mirroring deployCommand's own established pattern),
  // an MCP caller must know/pass the version explicitly.
  aart_deploy: z.object({ remote: z.string(), workflowId: z.string(), workflowVersion: z.string(), plan: z.boolean().optional() }),
  aart_trigger_workflow: z.object({
    workflowId: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    signal: signalSchema.optional(),
  }),
  aart_list_waiting_runs: z.object({ workflowId: z.string().optional() }),
  aart_resume_run: z.object({
    runId: z.string(),
    stepId: z.string().optional(),
    payload: z.unknown().optional(),
    signal: signalSchema.optional(),
  }),
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = (Object.keys(DESCRIPTIONS) as ToolName[]).map((name) => ({
  name,
  tier: TOOL_TIERS[name],
  description: DESCRIPTIONS[name],
  inputSchema: inputSchemas[name],
}));

export function getToolDefinition(name: ToolName): ToolDefinition {
  const def = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (!def) throw new Error(`Unknown tool "${name}"`);
  return def;
}
