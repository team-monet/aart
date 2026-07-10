// `aart init-agent` (spec §33.1) — generates MCP server config JSON +
// agent instruction file (architecture §10.4).
//
// "Generates: MCP server config JSON (pointing at `npx @team-monet/aart
// mcp`, §27.2 shape) + an agent instruction file (markdown, following the
// motivation-leading tool-description pattern cited as prior art — 'Shell
// runs and is forgotten. AART runs and is kept' — embedded directly in the
// generated instructions, not just in tool descriptions, since init-agent's
// whole purpose is front-loading exactly this framing before the agent's
// first tool call)." The quote is validated prior art from the v0.x
// prototype (/Users/johnlee/code/aa-runtime/src/agent/guide.ts:71 —
// "Shell runs and is forgotten. aart runs and is kept."); this instruction
// file updates the prototype's tool names/authoring loop to the v2 spec
// (aart_* naming, spec §32-34's core/extended tool surface and
// register -> validate -> run/verify loop, spec §17.5's mode-aware
// approval surfaces) while keeping the same motivation-leading voice.
import type { TrustMode } from "@aart/types";

export interface McpConfig {
  mcpServers: {
    aart: { command: string; args: string[] };
  };
}

export interface InitAgentOutputs {
  mcpConfig: McpConfig;
  /** JSON.stringify(mcpConfig, null, 2) — what actually gets written to disk. */
  mcpConfigJson: string;
  instructions: string;
}

export interface GenerateInitAgentOptions {
  /** Defaults to "@team-monet/aart" (ADR-18 — the one published package). */
  packageName?: string;
  /** Surfaced in the instructions' approval section so the generated file matches the project's actual configured mode rather than describing all four generically. */
  trustMode?: TrustMode;
}

const APPROVAL_SECTION_BY_MODE: Record<TrustMode, string> = {
  dev: "This project runs in **dev** mode: draft workflows execute immediately with a warning. Approval is not enforced — treat every run as provisional until a human reviews it.",
  governed:
    "This project runs in **governed** mode: reusable workflows require approval before trusted execution. Call `aart_request_approval`, present the summary to the user, and once they say yes, call `aart_approve` — never approve unprompted.",
  strict:
    "This project runs in **strict** mode: `aart_approve` is **not registered** as a tool here — approval can only happen out-of-band via the CLI (`aart approve`) or the dashboard. Call `aart_request_approval` to create the request, then tell the user to approve it outside this chat.",
  production:
    "This project runs in **production** mode: approval requires every gate to pass (validate, readiness, evals, riskReview, humanReview), and `aart_approve` is **not registered** as a tool here. Call `aart_request_approval`, make sure `aart_run_eval` has passed, and direct the user to the CLI (`aart approve`) or dashboard to finish approval.",
};

export function generateInitAgentOutputs(options: GenerateInitAgentOptions = {}): InitAgentOutputs {
  const packageName = options.packageName ?? "@team-monet/aart";
  const trustMode = options.trustMode ?? "governed";

  // spec §27.2's exact shape: { "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"] }
  // — wrapped in the standard `mcpServers.<name>` envelope real MCP clients
  // (Claude Code / Claude Desktop `.mcp.json`) expect, so the generated file
  // is directly usable, not just illustrative.
  const mcpConfig: McpConfig = {
    mcpServers: {
      aart: {
        command: "npx",
        args: ["-y", packageName, "mcp"],
      },
    },
  };

  const instructions = `# Using AART (Agentic Automation RunTime)

> Shell runs and is forgotten. AART runs and is kept.

AART does not call an LLM on your behalf. **You** (the calling agent) author the workflow; AART validates it, governs it, runs it deterministically, and hands back an evidence report you can trust.

## The verify reflex

Before you say something works, prove it:

\`\`\`
aart_verify({ url, expect })
\`\`\`

One call loads the page/endpoint, checks it, and returns a compact evidence report (pass/fail, artifacts, a screenshot for a browser target). Reach for it the way you reach for a test suite — reading the code doesn't tell you whether the thing actually renders or responds.

## Why reach for AART instead of a one-off script

You're about to do something by hand, or via a throwaway script. Pause: will this be done again, does its result need to be trustworthy, or should the user own it as a durable asset? If yes, author an AART workflow instead:

- **Reusable** — named, versioned, saved to the registry. Author once, re-run on demand or on a schedule.
- **Governed** — the workflow's approval state and gates are explicit and enforced by trust mode, not implicit in whether a human happened to glance at a diff.
- **Evidence** — every run writes an ordered per-step trace, pass/fail, and artifacts. \`aart_get_report\` proves it, it doesn't just claim it.

A truly one-off probe is still fine as a raw command. But anything you or the user will run again belongs in a workflow, or — for a single repeatable CLI operation — a \`command\` block, so every execution is captured in run history instead of vanishing shell output.

## The authoring loop

1. **Discover.** \`aart_find_blocks\` (by query) or \`aart_list_blocks\` (the full catalog) to see what you can compose. \`aart_propose_workflow\` returns a ready-made recipe skeleton if your request matches one of the built-in patterns (verify a page, check API health, wait for approval, ...) — check this before composing from scratch.
2. **Draft.** Compose blocks into steps using the \`uses\`/\`with\` shape (the same shape as GitHub Actions — if you know \`steps: - uses: ... with: ...\`, you already know this). \`aart_get_schema\` gives the exact input/output shape for a block or for the \`Workflow\` type itself.
3. **Register.** Call \`aart_register_block\` with your draft. It saves as a **draft** version. *Next: \`aart_validate\`.*
4. **Validate.** Call \`aart_validate\`. Fix every reported finding — errors block, warnings don't; a finding may include a \`didYouMean\`/\`correctedSnippet\` you can apply directly and re-validate.
5. **Run.** Call \`aart_run_workflow\` with the registered id and any \`input\`. For a quick one-shot check instead of a saved workflow, use \`aart_verify\`.
6. **Report.** Call \`aart_get_report\` to read the per-step trace, outputs, and artifacts. If it failed, revise the draft (back to step 2) and loop.

## Wiring data between steps

- \`{{ inputs.name }}\` — a workflow input.
- \`{{ steps.stepId.outputs.field }}\` — a previous step's output.
- \`{{ secrets.NAME }}\` — a secret. Never put a real secret in a literal input value; secrets are resolved at run time and redacted from reports.

Expressions are property paths only (\`{{ }}\`, GitHub-Actions-familiar) — no operators, no function calls. Compute a derived value in a step and reference its output instead.

## Approval

${APPROVAL_SECTION_BY_MODE[trustMode]}

\`aart_request_approval\` creates the request — the agent can never self-approve, in any mode.

## When a block doesn't exist yet

Climb the ladder, stopping at the first rung that works: compose existing blocks (\`aart_find_blocks\` first, always) -> a \`node\`/\`command\` block for custom logic or a host CLI you'd otherwise shell out to -> a workspace pack for a reusable family of blocks. Don't fake a missing capability with a brittle workaround.

## Rules

- Reference only block ids that actually exist (\`aart_find_blocks\`/\`aart_get_block\` first).
- Treat the run report as the source of truth for whether something worked — never claim success without one.
- Every tool result names the next step of this loop in its \`next\` field — follow it rather than re-deriving the loop from scratch each time.
`;

  const mcpConfigJson = JSON.stringify(mcpConfig, null, 2);
  return { mcpConfig, mcpConfigJson, instructions };
}
