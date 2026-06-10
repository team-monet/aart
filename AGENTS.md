# Working in this repo (for coding agents)

`aart` is a deterministic block/workflow **runtime**. It does **not** call an LLM.
When the user wants an automation built, **you (the coding agent) are the author**:
you discover what exists, draft the workflow/block, and aart validates, governs,
runs it deterministically, and gives you a structured report to iterate on.

## Drive aart entirely through MCP tools

Start `aart mcp` (stdio). **Do everything via these tools — the user shouldn't
type `aart` commands.** The server's `instructions` carry the full authoring guide.

| tool | purpose |
|---|---|
| `aa_list_blocks` | discover the catalog to compose from |
| `aa_get_block` | inspect one definition |
| `aa_get_schema` | the definition JSON Schema + authoring guide |
| `aa_validate` | check a draft (schema + referenced blocks exist) |
| `aa_register_block` | save a validated draft (lands as **draft**) |
| `aa_approve` | mark a draft approved — **only after the user agrees in chat** |
| `aa_run_workflow` | run an **approved** workflow → structured report |
| `aa_get_report` / `aa_list_runs` | fetch a past report / list recent runs |
| `aa_deprecate` | mark a definition deprecated |
| `aa_register_pack` | record a workspace pack (`.aa/packs/<name>`) as draft — never executes it |
| `aa_approve_pack` | after the user agrees: load the pack live; its blocks become `native` |

## The loop

1. **Discover** existing blocks (`aa_list_blocks`) — reuse before authoring new.
2. **Draft** a definition that matches `aa_get_schema` (compose existing blocks).
3. **Validate** (`aa_validate`) — fix every error.
4. **Register** (`aa_register_block`) — it lands as **draft**.
5. **Ask the user to approve** it (tell them what it does). When they say yes,
   call `aa_approve`. (Re-registering after an edit resets it to draft.)
6. **Run** (`aa_run_workflow`), **read the report**, revise, repeat.

The CLI mirrors all of this (`aart list/validate/block add/approve/run/report/
pack register|approve|list/doctor`) for when *you* need it, but prefer the
tools so the user doesn't type commands.

## Authoring quick reference

- A workflow **is** a block with `execution.type: workflow` and ordered `steps`.
- Wire data: `"{{inputs.x}}"` (string interp), `"$stepId.out"` (typed ref, nestable),
  `"{{ctx.runId}}"`, and `"{{secrets.NAME}}"` for credentials. Secrets come from
  `AART_SECRET_<NAME>` env vars or `.aa/secrets.json` and are best-effort redacted
  from the report — never put a real secret in an input literal. When you
  screenshot a page where a secret was typed into a visible field, pass the
  screenshot block's `mask` (selectors) — artifact contents are not redacted.
- Branch: a step's `if` is a **safe comparison** (`inputs.n > 3`), jumping to
  `then`/`else`; or use `next`; else steps fall through in order.
- Reference only block ids that exist. Keep `node` code small and single-purpose.
- A CLI you'd run more than once belongs in a `command` block: fixed binary +
  argv template (inputs fill slots; no shell), approved as a shape, every
  execution recorded in run history. Don't let repeat commands vanish into shell.
- A `node` block is sandboxed pure compute — unless it declares `dependencies`
  (npm packages / `node:` built-ins): then it runs as a real Node process with
  `require`, **unsandboxed**, so the user must approve it knowing that. For
  reusable native blocks or shared resources (sessions, pools), author a
  **workspace pack** under `.aa/packs/<name>/` — registering never executes it;
  approval loads it. When a capability is missing, build the block — don't
  fake it with workarounds or declare it impossible.

## Releasing

The user publishes to npm manually (possibly between your sessions). Before
committing a feature, run `npm view @team-monet/aart version` — if it equals
the local package.json version, that version is TAKEN: bump the minor in the
same commit, in all three spots (package.json, `src/cli/index.ts` `.version()`,
`src/mcp/server.ts` server version) plus `npm i --package-lock-only`. Never
stack features on an already-published version number.

Run `aart context` for the canonical, always-current version of this guide plus
the live block catalog. Project conventions & roadmap: `docs/IMPLEMENTATION_PLAN.md`.
