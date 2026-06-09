/**
 * The authoring guide. Single source for "what and how", reused verbatim as the
 * MCP server's `instructions` and the `aart context` output.
 *
 * aart does NOT call an LLM. YOU (the calling agent) author; aart validates,
 * governs, runs deterministically, and returns an evidence report.
 */
export const AUTHORING_GUIDE = `# Using aart (Agentic Automation RunTime)

You (the agent) build and run automations for the user **entirely through the
aart tools** — the user should never have to type an \`aart\` command themselves.
aart does not call an LLM; you do the authoring, aart validates, runs
deterministically, and returns an evidence report you read and iterate on.

## Recipe — to build & run an automation

1. **Discover.** Call \`aa_list_blocks\` to see what you can compose. The QA pack
   is built in: \`qa.browser.goto/click/fill/text_visible/screenshot\`,
   \`qa.api.request\`, \`qa.assert.equals/contains\` (these are \`native\` = trusted,
   ready to use). Reuse before authoring anything new.
2. **Draft.** Write a workflow definition (a JSON object) that composes those
   blocks. Get the exact shape from \`aa_get_schema\`. A workflow is a block with
   \`execution.type: "workflow"\` and an ordered \`steps\` array.
3. **Validate.** Call \`aa_validate\` with your draft. Fix every error it reports.
4. **Register.** Call \`aa_register_block\`. It saves as **draft** (not yet runnable).
5. **Get the user's approval.** Tell the user what the workflow does and ask them
   to approve it. When they say yes, call \`aa_approve\` with its id. (If you edit
   and re-register it, it returns to draft — ask again.)
6. **Run.** Call \`aa_run_workflow\` with the id and any \`input\`. Read the report
   it returns (per-step trace, outputs, screenshots/artifacts, pass/fail). If it
   failed, revise the draft and loop.

Do all of this with tools. Only mention CLI commands if the user explicitly asks.

## Worked example

A workflow that opens a page and checks text is visible:

\`\`\`json
{
  "id": "dashboard-check",
  "name": "Dashboard Check",
  "version": "0.1.0",
  "inputs": [{ "name": "url", "type": "string", "required": true }],
  "execution": {
    "type": "workflow",
    "steps": [
      { "id": "open", "block": "qa.browser.goto", "inputs": { "url": "{{inputs.url}}" } },
      { "id": "see", "block": "qa.browser.text_visible", "inputs": { "text": "Dashboard" } },
      { "id": "shot", "block": "qa.browser.screenshot", "inputs": { "name": "dashboard" } }
    ],
    "outputMapping": { "screenshot": "$shot.artifact" }
  }
}
\`\`\`

→ \`aa_validate\` it → \`aa_register_block\` it → ask the user to approve →
\`aa_approve\` → \`aa_run_workflow\` { id: "dashboard-check", input: { url: "..." } }.

## Wiring data between steps

- \`"{{inputs.name}}"\`     — a workflow input.
- \`"$stepId.outputName"\`  — a previous step's output (keeps its type; nested
  paths like \`$stepId.user.id\` are allowed).
- \`"{{secrets.NAME}}"\`    — a secret (e.g. a password). Use this for credentials;
  NEVER put a real secret in an input literal. Values come from
  \`AART_SECRET_<NAME>\` env vars or \`.aa/secrets.json\` and are redacted from the
  report. (Screenshot CONTENTS aren't redacted — pass the screenshot block's
  \`mask\` list of selectors to black out a visible secret field.)

## Control flow (per step)

- \`if\` — a safe boolean expression (\`inputs.n > 3\`, \`$s1.ok === true\`); on true
  go to \`then\`, else \`else\`.
- \`next\` — explicit next step id; otherwise steps run in order.

## Approval (it's the user's call, made in chat)

- Every registration is **draft**. A draft can't run until approved.
- **You ask; the user decides.** Present what it does, and approve via
  \`aa_approve\` only once the user agrees — never approve unprompted.
- The catalog shows each block's \`status\`: \`native\` (trusted, always usable),
  \`draft\`, \`approved\`, \`deprecated\`.

## Block types

- \`workflow\` — composes other blocks (what you'll usually write).
- \`native\` — trusted pack primitives (the \`qa.*\` blocks). Compose them; don't
  re-author them.
- \`node\` — custom JavaScript, run in a locked-down sandbox (no \`process\`,
  \`require\`, fs, network). Pure compute: gets \`inputs\` + \`ctx\` {runId,vars},
  returns a JSON object. No capabilities/secrets — for a browser or HTTP, use the
  \`qa.*\` blocks instead. Prefer composing existing blocks over writing node code.

## Rules

- Reference only block ids that exist.
- Treat the run report as the source of truth — "reports prove it".
`
