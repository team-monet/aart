/**
 * The authoring guide. This is the single source for "what and how" that makes
 * a coding agent aware of how to author for aart. It is reused verbatim as:
 *   - the MCP server's `instructions` field (server/mcp.ts),
 *   - the `aart context` output (cli/commands/context.ts),
 *   - docs/AGENT_GUIDE.md.
 *
 * IMPORTANT: aart does NOT call an LLM. Block & workflow *generation is done by
 * the calling coding agent* (Claude Code, Codex, etc.). aart's job is to tell
 * the agent what blocks exist and how to author, then validate, govern, execute
 * deterministically, and return a structured report.
 */
export const AUTHORING_GUIDE = `# Authoring for aart (Agentic Automation RunTime)

You (the coding agent) are the AUTHOR. aart is the runtime: it does not call an
LLM. You discover what exists, draft a workflow or block, aart validates it, a
human approves it, aart runs it deterministically and returns an evidence report
you can read and iterate on.

## The model

- A **block** is the minimal unit of work. Its \`execution.type\` is one of:
  - \`node\` — JavaScript that runs in a locked-down V8 isolate (no \`process\`,
    \`require\`, fs, network, or timers). It is PURE COMPUTE: it may reference
    \`inputs\` and \`ctx\` ({runId, vars}) and must \`return\` a JSON-serializable
    object matching its \`outputs\`. It gets no capabilities/secrets — if you need
    a browser or HTTP, compose the native \`qa.*\` blocks instead. Code must
    compile to register, runs under a memory + time limit, and is killed if it
    exceeds them;
  - \`workflow\` — an ordered list of \`steps\`, each invoking another block;
  - \`native\` — a trusted primitive shipped by a pack (e.g. \`qa.api.request\`,
    \`qa.browser.*\`). You compose these as steps but never author or re-register
    them — they show up in the catalog / \`aart list\` tagged \`[native]\`, and
    registering a block id that already exists as native is refused.
- A **workflow IS a block** whose \`execution.type === 'workflow'\`. Same schema,
  same registry. Compose existing blocks; do not re-author primitives.
- Some blocks declare \`capabilities\` (e.g. \`browser\`); the runtime sets those
  up automatically for the run — you don't manage them.

## Wiring data between steps

- \`"{{inputs.name}}"\`     — interpolate a workflow input into a string.
- \`"$stepId.outputName"\`  — reference a previous step's output (keeps its type;
  nested paths like \`$stepId.user.id\` are allowed).
- \`"{{ctx.runId}}"\`       — interpolate runtime context (runId, vars).
- \`"{{secrets.NAME}}"\`    — interpolate a secret (e.g. a password). Use this for
  credentials — NEVER put a real secret in a step input literal or pass it as a
  plain input. Secret values are sourced from \`AART_SECRET_<NAME>\` env vars or
  \`.aa/secrets.json\`, and are best-effort REDACTED from the run report. Caveat:
  screenshot/artifact CONTENTS are not redacted — when screenshotting a page where
  a secret was typed into a visible field, pass the screenshot block's \`mask\`
  (a list of selectors) to black those fields out.

## Control flow (per step)

- \`if\` — a SAFE boolean expression (e.g. \`inputs.n > 3\`, \`$s1.ok === true\`).
  On true jump to \`then\`, else to \`else\`. (No arbitrary JS — comparisons and
  truthiness only.)
- \`next\` — explicit next step id. Absent any of these, steps fall through in
  array order.

## The loop you should follow

1. **Discover** — list available blocks (\`aart list --json\` or the
   \`aa_list_blocks\` tool). Reuse before authoring new.
2. **Draft** — write a definition (YAML/JSON) that matches the schema
   (\`aart schema\` / \`aa_get_schema\`), composing existing blocks.
3. **Validate** — \`aart validate <file>\` / \`aa_validate\`. Fix every error.
4. **Register** — \`aa_register_block\`. It lands as **draft**.
5. **Get approval** — you CANNOT run a draft. Ask the human to review and
   approve it (\`aart approve <id>\`); they can also test it once with
   \`aart run <id> --yes\`. Only approved definitions run.
6. **Run** — \`aa_run_workflow\` (works once the definition is approved).
7. **Inspect** — read the returned report (per-step trace, outputs, error,
   artifacts). If it failed, revise and re-register (which resets it to draft,
   needing re-approval).

## Governance (the human approves, you don't)

- Every registration lands as **draft**. Only a human, via the \`aart approve\`
  CLI command, can mark a definition **approved** — there is no approve tool for
  you. Do not try to approve your own work.
- \`aa_run_workflow\` refuses any definition that is not approved (and refuses an
  inline definition outright). Register it, then ask the human to approve.
- The catalog shows each block's \`status\`: \`native\` (built-in, trusted),
  \`draft\`, \`approved\`, or \`deprecated\`. Native pack blocks are always usable.

## Rules

- Reference only block ids that exist (validation rejects unknown blocks).
- Keep node block code small and single-responsibility; declare its \`outputs\`.
- Prefer composing a workflow from existing blocks over writing new node code.
- Treat the run report as the source of truth — "reports prove it".
`
