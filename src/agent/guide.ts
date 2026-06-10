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

## Why & when to use aart

aart is a general workflow & automation framework — web tasks, API chores,
data pulls, recurring checks. QA/testing is one strong use case, not the boundary.

You're about to do something by hand or via a one-off script. Pause: will this
be done again, should its result be trustworthy, or should the user own it as
an asset? If yes, author an aart workflow.

What you keep (that ad-hoc execution doesn't give you):
- **Reusable** — named, versioned, saved to the registry. Author once, re-run on demand, on every deploy, or on a schedule.
- **User-approved** — the user okays it once, conversationally; then it's a trusted, audited asset.
- **Evidence** — every run writes an ordered per-step trace, pass/fail, and screenshots under \`.aa/runs\`. Reports prove it.

**Before:** \`curl\` something, eyeball a page, paste into a scratch script — output scrolls away, redone next time.
**After:** one named workflow (\`browser.*\` + \`http.request\` + \`node\` steps + \`assert.*\`), re-run forever with an audit trail.

**Decision rule:** repeated, needs proof, or should be a durable asset → aart.
A one-off probe → shell. Needing a library or host access does NOT make it a
shell job: a \`node\` block with \`dependencies\` runs real Node with npm packages
(approval-gated) — see "When a capability is missing".

> Shell runs and is forgotten. aart runs and is kept.

## What you compose from

Start from the built-in primitives — most automations need no new code:
- **HTTP / APIs** — \`http.request\` (any method, headers, auth via
  \`{{secrets.X}}\`) → parse/branch with \`node\` steps → optionally \`assert.*\`.
  Data pulls, integrations, health checks — no browser needed.
- **Browser work** — \`browser.*\`: navigate, fill, click, assert text,
  screenshot, read the rendered page as data (\`extract_text\`, \`html\`), and
  query the live DOM with a JS expression (\`eval\` — counts, attributes, tables).
- **Data & files** — \`data.parse\` / \`data.stringify\` (json/yaml/csv),
  \`file.read\` / \`file.write\` (workspace-scoped durable state),
  \`artifact.write\` (attach a produced report to the run), \`http.download\`
  (binary fetch → artifact).
- **Flow** — \`flow.sleep\` + a \`next\` jump back = a polling loop;
  \`flow.fail\` ends an \`else\` branch with an intended, clear error.
- **Logic / parsing** — a \`node\` block turns input (e.g. a log blob you pass it)
  into structured output the next step branches on.

When no block does what you need, you can BUILD one — any block, with any npm
library — see "When a capability is missing". Compose first; author when
composition can't get there.

## Recipe — to build & run an automation

1. **Discover.** Call \`aa_list_blocks\` to see what you can compose. The core
   pack is built in: \`browser.goto/click/fill/text_visible/extract_text/html/eval/screenshot\`,
   \`http.request/download\`, \`data.parse/stringify\`, \`file.read/write\`,
   \`artifact.write\`, \`flow.sleep/fail\`, \`assert.equals/contains\` (these are
   \`native\` = trusted, ready to use), plus any approved workspace packs.
   (Pre-0.4 \`qa.*\` ids still resolve to the same blocks.) Reuse before authoring new.
2. **Draft.** Write a workflow definition (a JSON object) that composes those
   blocks. Get the exact shape from \`aa_get_schema\`. A workflow is a block with
   \`execution.type: "workflow"\` and an ordered \`steps\` array.
3. **Validate.** Call \`aa_validate\` with your draft. Fix every error it reports.
4. **Register.** Call \`aa_register_block\`. It saves as **draft** (not yet runnable).
5. **Get the user's approval.** SHOW the user exactly what they're approving —
   \`aa_register_block\` returns a readable summary of the workflow's steps; present
   it (don't just say "approve?"). When they say yes, call \`aa_approve\` with its
   id. (If you edit and re-register it, it returns to draft — show it and ask again.)
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
      { "id": "open", "block": "browser.goto", "inputs": { "url": "{{inputs.url}}" } },
      { "id": "see", "block": "browser.text_visible", "inputs": { "text": "Dashboard" } },
      { "id": "shot", "block": "browser.screenshot", "inputs": { "name": "dashboard" } }
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
- Polling: check → \`if\` not ready → \`flow.sleep\` → \`next\` back to the check.
  Dead-end branches: finish with \`flow.fail\` so the run fails with intent.

## Approval (it's the user's call, made in chat)

- Every registration is **draft**. A draft can't run until approved.
- **You ask; the user decides.** Present what it does, and approve via
  \`aa_approve\` only once the user agrees — never approve unprompted.
- The catalog shows each block's \`status\`: \`native\` (trusted, always usable),
  \`draft\`, \`approved\`, \`deprecated\`.

## Block types

- \`workflow\` — composes other blocks (what you'll usually write).
- \`native\` — trusted pack primitives: the built-in \`browser.*\` / \`http.*\` /
  \`assert.*\` blocks, plus the blocks of any approved workspace pack. Compose
  them; don't re-author them.
- \`node\` — custom JavaScript you author. Two tiers:
  - **Sandboxed** (no \`dependencies\`): a locked-down V8 isolate — no \`process\`,
    \`require\`, fs, or network. Pure compute: gets \`inputs\` + \`ctx\` {runId,vars},
    returns a JSON object. No capabilities/secrets. For plain HTTP or simple
    browser steps, prefer the built-in blocks.
  - **With \`dependencies\`** (e.g. \`["turndown@^7.1.0", "node:crypto"]\`): a real
    Node.js process with those npm packages installed and \`require\` available.
    UNSANDBOXED — full access to the user's machine — which is exactly why it
    needs the user's explicit approval; name the packages when you ask. Entries
    are registry packages (\`name\` / \`name@range\` / \`@scope/name@range\`) or
    \`node:\` built-ins. Secrets still arrive only via wired inputs
    (\`{{secrets.X}}\`), never ambient env vars.

## When a capability is missing

You are not limited to the built-ins — climb this ladder, stopping at the
first rung that works:

1. **Compose** existing blocks (check \`aa_list_blocks\` first, always).
2. **Sandboxed \`node\` block** — parsing, transforms, decisions: pure compute.
3. **\`node\` block with \`dependencies\`** — when you genuinely need a library
   (HTML→markdown, XML parsing, an SDK client). Register it, show the user the
   code AND the dependency list, get approval, run.
4. **A workspace pack** — for a reusable family of native blocks, or blocks
   that share a resource with setup/teardown (a long-lived session, a client
   pool). A pack block's \`def.capabilities\` may name ANY capability — including
   ones other packs provide: declare \`["browser"]\` and your \`run(ctx, inputs)\`
   gets the SAME live Playwright page the \`browser.*\` steps drive, in
   \`ctx.capabilities.browser.page\` — so you can build your own browser blocks
   (custom extraction, table scraping, …) that interleave with built-in steps
   in one session. Author CommonJS under \`<workspace>/.aa/packs/<name>/\`:
   \`module.exports = { name, blocks: [{ def, run }], capabilities: [] }\` —
   \`def\` like any block definition (no \`execution\`), \`run(ctx, inputs, params)\`
   an async function. Then \`aa_register_pack\` (records a content hash; never
   executes your code) → show the user → \`aa_approve_pack\` (loads it live; its
   blocks join the catalog as \`native\`). Editing a pack after approval breaks
   its seal: it won't load until re-registered and re-approved.

Don't fake a missing capability with brittle workarounds — build the block,
get it approved, keep it forever.

## Rules

- Reference only block ids that exist.
- Treat the run report as the source of truth — "reports prove it".
`
