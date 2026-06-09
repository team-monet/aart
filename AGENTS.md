# Working in this repo (for coding agents)

`aart` is a deterministic block/workflow **runtime**. It does **not** call an LLM.
When the user wants an automation built, **you (the coding agent) are the author**:
you discover what exists, draft the workflow/block, and aart validates, governs,
runs it deterministically, and gives you a structured report to iterate on.

## Two ways to drive aart

**MCP (preferred):** start `aart mcp` (stdio). You get these tools, and the
server's `instructions` carry the full authoring guide:

| tool | purpose |
|---|---|
| `aa_list_blocks` | discover the catalog to compose from |
| `aa_get_block` | inspect one definition |
| `aa_get_schema` | the definition JSON Schema + authoring guide |
| `aa_validate` | check a draft (schema + referenced blocks exist) |
| `aa_register_block` | save a validated draft (lands as **draft** — pending human approval) |
| `aa_run_workflow` | run an **approved** registry workflow → structured report |
| `aa_get_report` | fetch a past run record |

**CLI (equivalent):**
```bash
aart context                 # guide + live catalog + schema, all in one
aart list --json             # machine-readable catalog (incl. approval status)
aart schema                  # definition JSON Schema
aart validate <file>         # validate a draft before registering
aart block add <file>        # validate + register (lands as draft)
aart show <id>               # print a definition (review before approving)
aart approve <id>            # human-only: approve a definition for use
aart run <id|file> -i '{…}'  # run an approved def (--yes to override once)
aart report <runId>          # replay a past report
```

## The loop

1. **Discover** existing blocks — reuse before authoring new.
2. **Draft** a definition that matches the schema (compose existing blocks).
3. **Validate** — fix every error.
4. **Register** (`aa_register_block`) — it lands as **draft**.
5. **Ask the human to approve** it (`aart approve <id>`). You can't run a draft,
   and there is no approve tool for you — the human governs.
6. **Run** (`aa_run_workflow`, once approved), then **read the report**; revise;
   re-register (resets to draft) and repeat.

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

Run `aart context` for the canonical, always-current version of this guide plus
the live block catalog. Project conventions & roadmap: `docs/IMPLEMENTATION_PLAN.md`.
