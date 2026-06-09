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

- A **block** is the minimal unit of work. Its \`execution.type\` is either:
  - \`node\` — JavaScript with a \`code\` body that may reference \`inputs\` and
    \`ctx\` and \`return\`s an object matching its declared \`outputs\`; or
  - \`workflow\` — an ordered list of \`steps\`, each invoking another block.
- A **workflow IS a block** whose \`execution.type === 'workflow'\`. Same schema,
  same registry. Compose existing blocks; do not re-author primitives.

## Wiring data between steps

- \`"{{inputs.name}}"\`     — interpolate a workflow input into a string.
- \`"$stepId.outputName"\`  — reference a previous step's output (keeps its type;
  nested paths like \`$stepId.user.id\` are allowed).
- \`"{{ctx.runId}}"\`       — interpolate runtime context (runId, vars).

(Secrets are not wired into step interpolation yet — see docs/IMPLEMENTATION_PLAN.md.
Inside a \`node\` block's code you can read \`ctx.secrets\`, but do not reference
secrets in step \`inputs\` for now.)

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
4. **Approve** — present the draft to the human for approval (this is a gate;
   never self-approve and run destructive things silently).
5. **Register** — \`aart block add <file>\` / \`aa_register_block\`.
6. **Run** — \`aart run <id> --input '{...}'\` / \`aa_run_workflow\`.
7. **Inspect** — read the returned report (per-step trace, outputs, error,
   artifacts). If it failed, revise the workflow/block and loop.

## Rules

- Reference only block ids that exist (validation rejects unknown blocks).
- Keep node block code small and single-responsibility; declare its \`outputs\`.
- Prefer composing a workflow from existing blocks over writing new node code.
- Treat the run report as the source of truth — "reports prove it".
`
