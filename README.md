# aart — Agentic Automation RunTime

> AI creates reusable automation blocks and workflows. Humans govern them.
> A portable runtime executes them deterministically. Reports prove it.

A governed **block/workflow runtime for AI agents**. The core is generic; QA is
the first pluggable pack (the dogfood wedge). CLI first, MCP second, no web UI.

**Generation is done by the calling coding agent — aart never calls an LLM.**
Your agent (Claude Code, Codex, …) authors blocks/workflows; aart makes it aware
of what exists and how to author (`aart context` / the MCP server), validates the
draft, runs it deterministically, and returns a structured report to iterate on.
See [AGENTS.md](AGENTS.md).

This is the ground-up rebuild of the legacy `../aa` prototype. See
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full plan and
the salvage decisions behind it.

## Status

The **core runtime + agent interface + QA pack are working and tested**; the
governance gate and a real `node`-code sandbox are the next phases.

| Layer | State |
|---|---|
| Core types (zod), resolver, engine, report | ✅ working + tested |
| Filesystem registry (semver, cached) | ✅ working + tested |
| CLI (`run`, `block add/list`, `validate`, `schema`, `context`, `report`, `mcp`) | ✅ working |
| Agent interface (catalog + schema + guide + validate) | ✅ working |
| MCP server (`aart mcp`, 7 tools) | ✅ working (verified over stdio) |
| Capability model + native pack blocks | ✅ working |
| QA pack — `qa.api.*`, `qa.assert.*`, `qa.browser.*` (Playwright) | ✅ working (verified incl. real Chromium) |
| Secrets (`{{secrets.NAME}}`, redacted from reports) | ✅ working |
| Approval gate (`draft`→`approved`, human-only) | ✅ working |
| `node` block sandbox (isolated-vm: own heap, memory cap, hard timeout) | ✅ working |
| Static gate (node code must compile to register) | ✅ working |

## Install & run

No clone needed — once published to npm:

```bash
npx aart --help                 # run without installing
# or:  npm i -g aart            # then `aart …`
npx playwright install chromium # only needed for the QA *browser* blocks
```

Point a coding agent's MCP config at it:

```json
{ "command": "npx", "args": ["-y", "aart", "mcp"],
  "env": { "AART_WORKSPACE": "/path/to/your/project" } }
```

`isolated-vm` (the `node`-block sandbox) is an **optional** dependency: it ships
prebuilt binaries for macOS (Apple Silicon), Linux (x64/arm64, incl. WSL2), and
Windows on recent Node — so `npm install` needs **no compiler** there. On an
uncovered combo (e.g. Intel mac, or an unusual Node version) it builds from
source (`build-essential python3` / Xcode CLT) — and if it's absent entirely,
install still succeeds: the QA pack (native browser/api/assert blocks) works, and
only authoring/running `node` blocks asks you to `npm i isolated-vm`.

(See [docs/PUBLISHING.md](docs/PUBLISHING.md) to publish; not yet on npm.)

## Quick start (from source)

```bash
npm install && npm link   # `prepare` builds dist/; link puts `aart` on PATH

aart block add examples/blocks/echo.block.yaml
aart block add examples/blocks/upper.block.yaml
# definitions land as `draft`; --yes runs an unapproved one once (or `aart approve`)
aart run examples/workflows/echo-smoke.workflow.yaml --input '{"start":"hello"}' --yes

npm test                  # unit + engine + QA tests
```

Expected: the workflow runs `echo → upper`, prints a per-step trace, returns
`{ "final": "HELLO" }`, and writes a report to `.aa/runs/<id>/run.json` (replay
with `aart report <id>`). (No `npm link`? Use `npm run dev -- <cmd>`.)

### Note for WSL2 / Linux

For the QA **browser** blocks, plain `npx playwright install chromium` is not
enough on a fresh Ubuntu/WSL2 — pull the system libraries too:

```bash
npx playwright install --with-deps chromium
```

- aart runs **its own headless Chromium** Linux-side — it does not use your
  Windows Chrome, and needs no display (no WSLg required).
- **Target URL:** an app *inside* WSL2 is reachable at `http://localhost:PORT`.
  An app on the **Windows host** is not reachable via `localhost` under default
  WSL2 NAT — use the host IP, or enable mirrored networking (`.wslconfig` →
  `[wsl2] networkingMode=mirrored`, Win11 22H2+). Remote/staging URLs just work.
- Keep the repo (and the Playwright browser cache) under your Linux home (`~/…`),
  not `/mnt/c/…`, to avoid slow 9p filesystem I/O.

## Governance (the approval gate)

"AI authors, humans govern." Every registration lands as **`draft`**; only a
human can promote it:

```bash
aart show <id>        # review the definition
aart approve <id>     # → approved (the only way to grant approval)
aart deprecate <id>   # → deprecated
```

- **Agents cannot approve** — `aa_register_block` always writes `draft`, and there
  is no MCP approve tool. An agent's `aa_run_workflow` refuses anything not
  `approved` (and refuses inline definitions).
- **You can override one run** with `aart run <id> --yes` (the report records it
  as an unapproved run). Approved definitions run without `--yes`.
- Built-in **pack blocks are trusted** (`native`); referenced blocks must be
  approved too (the gate is transitive). Re-registering an edited definition
  resets it to `draft`.
- **Honest scope:** this is a real boundary for an MCP-constrained agent and an
  audit trail for everyone. A coding agent with *shell access* can run
  `aart approve` itself — so treat the gate as deliberate-action governance, not
  a hard security control against a shell-capable agent.

## Workspace & secrets

- **Workspace** — all state lives under `<workspace>/.aa`. Resolution order:
  `--workspace <dir>` → `$AART_WORKSPACE` → cwd. **Set `AART_WORKSPACE` in your
  MCP server config** so `.aa` always lands in your project, whatever cwd the
  agent host uses.
- **Secrets** — reference credentials in a workflow as `{{secrets.NAME}}`. Values
  come from `AART_SECRET_<NAME>` env vars or `<workspace>/.aa/secrets.json`, and
  are best-effort **redacted** from the run report (verbatim + JSON/URL-encoded
  forms). Never put a real secret in an input. Caveat: artifact *contents* (e.g.
  screenshots) are **not** scrubbed — mask secret fields via the screenshot
  block's `mask` option. Treat the run dir as low-sensitivity, not secret-free.

## Concepts

- **Block** — the minimal unit of work. A block is `node` code *or* a
  `workflow`. A **workflow is just a block** whose `execution.type === 'workflow'`
  — one recursive model, one registry, one `run()`.
- **`inputs` ≠ `params` ≠ `ctx`** — data to process vs. behavior config vs. the
  runtime world (workspace, secrets, capabilities, artifacts, logging).
- **Registry** — versioned YAML on disk under `.aa/registry/blocks/`. No DB.
- **Run record** — a self-contained, snapshotted evidence report under
  `.aa/runs/`. "Reports prove it."
- **Pack** — built-in blocks + capabilities for a domain (QA first). Domain
  terms stay inside the pack; the core stays generic.

## Layout

```
src/
  core/        types, engine, context, resolver, report, executor, runtime, secrets
  registry/    file-registry (YAML on disk)
  artifacts/   artifact-store (evidence)
  agent/       guide, catalog, schema, validate (the "what & how" for coding agents)
  mcp/         stdio MCP server (the agent-callable interface)
  cli/         commander entrypoint + commands
  pack/        pack model: capabilities, native blocks, composite registry
  packs/qa/    QA pack — api.request, assert.*, browser.* (Playwright)
examples/      runnable example blocks + workflows
```

## Connecting a coding agent

Point your agent's MCP config at `aart mcp` (run in the project dir). On connect
it receives the authoring guide as `instructions` and the 7 `aa_*` tools. Or just
run `aart context` and paste. See [AGENTS.md](AGENTS.md).
