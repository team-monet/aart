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
  aart_find_tools:
    "Search registered local command tools and approved Pack tool declarations inertly, without running their version commands or probes, BEFORE workflows or blocks. Use this when the machine may already have a reliable authenticated CLI; skipping it causes agents to rebuild weaker scripts and duplicate credentials.",
  aart_register_tool:
    "Register a local command manifest as an immutable, versioned, searchable asset. Asset-owned executable bytes are copied inertly and sealed; external executables remain explicit prerequisites whose resolved hashes must be reviewed before execution. Interpreter entrypoints must explicitly declare standalone snapshot compatibility and a snapshot version check because package-relative context is not copied implicitly.",
  aart_check_tool:
    "Resolve one local tool's exact executable snapshot, rendered task argv, working directory, platform, authentication source, effects, prerequisites, and every declared version-check/probe argv without running any manifest command. Use the returned asset, executable, rendered-argv, cwd, and prerequisite-executable seals as one review boundary before execution.",
  aart_run_tool:
    "Run a checked local tool only when the caller supplies the exact reviewed asset, executable, rendered-argv, cwd, and prerequisite-executable seals. One stable authentication selection and durable run lifecycle covers every approved version check, probe, and task process; execution uses content-addressed snapshots with fixed argv and no shell. Never call it without explicit approval of the check summary.",
  aart_get_tool_run:
    "Fetch one durable local-tool execution record by runId after aart_run_tool actually spawned a process. Use it in a fresh session to verify the sealed executable, redacted argv/output, exit status, and mapped evidence instead of relying on chat memory.",
  aart_list_tool_runs:
    "List durable local-tool run records, including a process still marked running after the original caller disconnected. Use this to recover the runId and reviewed seals in a fresh session instead of losing evidence for a command that already started.",
  aart_find_blocks:
    "After checking aart_find_workflows, search the block catalog by keyword or category before you compose a new step. Reusing an existing block is always preferable to authoring new logic, and a block you didn't know existed is a block you'll otherwise reinvent badly.",
  aart_find_workflows:
    "Search the latest registered workflow versions by id, name, category, keywords, and examples BEFORE drafting a new workflow. This is the main reuse check: if another agent already produced a close workflow, adapt or version that durable asset instead of generating a different implementation from scratch.",
  aart_find_packs:
    "Search the configured public static Pack index before building new blocks or workflows. This is the remote half of search-before-build: it finds reusable assets published by other people without trusting or executing them.",
  aart_install_pack:
    "Download a public npm Pack, or copy one from a linked local directory, into AART's inert unapproved Pack store. Installation records provenance and a content seal but never executes code or grants trust.",
  aart_list_packs:
    "List installed Packs with provenance, content hash, and approval status. Use this to show a human exactly what is awaiting review before any approval decision.",
  aart_approve_pack:
    "After the user explicitly approves the exact Pack version/hash shown by aart_list_packs, validate its block modules and workflow definitions and record the human decision. NEVER call this without explicit user approval; approved blocks load only on the next process start, while imported workflows remain drafts.",
  aart_prepare_pack:
    "Validate a locally authored Pack before publication and generate its deterministic static-index entry as aart-index-entry.json inside that Pack directory. This evaluates only the author's local block modules, verifies package/manifest version alignment, and gives standard npm publishing plus the public JSON index an exact artifact to ship.",
  aart_get_block:
    "Get one block's exact manifest (input/output JSON Schema, capabilities, description) by id. Call this before wiring a step's `with:` — guessing a block's input shape is exactly the kind of thing that fails validation and costs a corrective round-trip.",
  aart_validate:
    "Validate a draft workflow (or an already-registered version) against AART's 5-class validation engine (schema, references, capabilities, input safety, deployment readiness). Every finding includes what's wrong and, where possible, a corrected snippet — fix errors (warnings never block) and call this again before running. Skipping this and going straight to aart_run_workflow just moves the same failure later, with less context to fix it.",
  aart_register_block:
    "Save a drafted workflow to the registry as a new version (status: draft). This is what turns a workflow you composed in this conversation into a durable, versioned, re-runnable asset instead of something that evaporates when the chat ends — 'Shell runs and is forgotten. AART runs and is kept.'",
  aart_run_workflow:
    "Execute a registered workflow by id and get back a run record (status, outputs, per-step trace). This is how a draft actually proves itself — call aart_validate first so a run failure means something real broke, not a shape you could have caught earlier.",
  aart_get_report:
    "Fetch the full evidence report for a run — the model-facing summary (headline, workflow outputs, failures, artifact references) or a human-readable markdown rendering. Treat this as the source of truth for what the workflow produced and whether it worked; never claim a run succeeded without having read its report.",
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
  // D2b "remote reads" (AMENDMENTS.md, this session) — the READ half of
  // seeing a deployed server (D1's "remotes + push," AMENDMENTS.md A56,
  // shipped the WRITE half). Descriptions deliberately do NOT claim these
  // give you a redacted-for-secrets view of a remote's data beyond what
  // aart_remote_run's own report-rendering seam already inherits — see that
  // tool's own description below for the precise, non-overclaiming wording.
  aart_remote_status:
    "Check whether a workflow's local state matches what's actually live on a remote aart server — one named remote, or every configured remote at once. Call this before assuming a deployed workflow reflects your latest local changes: drift (a version that was never pushed, or the SAME version with different gate/approval state) is invisible from local state alone, and a stale remote is a common reason 'it works locally but not in production' happens.",
  aart_remote_why:
    "Explain exactly what's live for one workflow on one remote, and why: which version is currently promoted/active there, its gates and approval, and — where tracked — who approved it. Call this when a deployed workflow behaves unexpectedly and you need the full picture before debugging further; 'is this even the version I think it's running' is the first question to answer, not an assumption to skip.",
  aart_remote_runs:
    "List recent runs of workflows on a remote aart server, optionally filtered by status — a compact summary per run (not full traces), so you can spot a failing remote run before pulling its full detail. Call this before aart_remote_run when you don't already know exactly which runId you're looking for.",
  aart_remote_run:
    "Fetch the full evidence report for one run on a remote aart server — the model-facing summary or markdown rendering, the same rendering aart_get_report gives for a local run. This is how you actually SEE what happened on a deployed workflow instead of guessing from local code or assuming a push succeeded — never claim a remote run worked without having read its report.",
  // Wave 2C (AMENDMENTS.md A65) — the WRITE-against-remote half D2b (A62)
  // explicitly deferred. Not overclaiming beyond aart_remote_run's own
  // established non-overclaiming precedent: this sends the SAME decision
  // aart_approve records locally to the remote's own write route, nothing
  // more.
  aart_remote_approve:
    "Record a human's approval decision against a PAUSED run or a pending workflow-version gate (humanReview/riskReview) on a REMOTE aart server — the same decision aart_approve records locally, sent instead to a named remote over HTTP. NEVER call this without the user having explicitly said yes to what you showed them, exactly like aart_approve — this is not a way to unblock a remote run any more than aart_approve is a way to unblock a local one. Not available in strict/production trust modes (the same aart_approve mode gate applies here too — a caller denied local approval cannot use a remote as a workaround), and absent entirely with zero configured remotes.",
};

const inputSchemas: Record<ToolName, z.ZodType> = {
  aart_find_tools: z.object({
    query: z.string(),
    scope: z.enum(["local", "remote", "all"]).optional(),
    indexUrl: z.string().url().optional(),
  }),
  aart_register_tool: z.object({ tool: z.unknown(), sourcePath: z.string().optional() }),
  aart_check_tool: z.object({
    id: z.string(),
    version: z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),
  }),
  aart_run_tool: z.object({
    id: z.string(),
    version: z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    executableHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    argvHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    cwdHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    prerequisiteHashes: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/)).optional(),
  }),
  aart_get_tool_run: z.object({ runId: z.string().regex(/^toolrun_[0-9a-f-]{36}$/) }),
  aart_list_tool_runs: z.object({
    toolId: z.string().optional(),
    status: z.enum(["running", "terminal"]).optional(),
  }),
  aart_find_blocks: z.object({
    query: z.string(),
    category: z.string().optional(),
    scope: z.enum(["local", "remote", "all"]).optional(),
    indexUrl: z.string().url().optional(),
  }),
  aart_find_workflows: z.object({
    query: z.string(),
    category: z.string().optional(),
    scope: z.enum(["local", "remote", "all"]).optional(),
    indexUrl: z.string().url().optional(),
  }),
  aart_find_packs: z.object({ query: z.string(), indexUrl: z.string().url().optional() }),
  aart_install_pack: z.object({
    name: z.string(),
    version: z.string().optional(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    sourcePath: z.string().optional(),
  }),
  aart_list_packs: z.object({ status: z.enum(["unapproved", "approved"]).optional() }),
  aart_approve_pack: z.object({
    name: z.string(),
    version: z.string(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reviewer: z.string(),
  }),
  aart_prepare_pack: z.object({ sourcePath: z.string() }),
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
  // D2b "remote reads" (AMENDMENTS.md, this session).
  aart_remote_status: z.object({ workflowId: z.string(), remote: z.string().optional() }),
  aart_remote_why: z.object({ remote: z.string(), workflowId: z.string() }),
  // The six literal values mirror @aart/types' RunStatusSchema (run.ts)
  // exactly — reproduced as a literal enum here (not imported) to match
  // this file's own established convention: every OTHER inputSchema below
  // is a self-contained Zod definition, never a cross-package schema reuse.
  aart_remote_runs: z.object({ remote: z.string(), status: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled"]).optional() }),
  aart_remote_run: z.object({ remote: z.string(), runId: z.string(), format: z.enum(["model", "markdown"]).optional() }),
  // Wave 2C (AMENDMENTS.md A65) — mirrors aart_approve's own schema exactly
  // (taskId/decision/reviewer) PLUS the target remote name.
  aart_remote_approve: z.object({ remote: z.string(), taskId: z.string(), decision: z.enum(["approved", "rejected", "needs_changes"]), reviewer: z.string() }),
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
