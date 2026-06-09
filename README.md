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

Early skeleton. The **core runtime is real and runnable**; AI generation and the
QA pack are stubbed for later phases.

| Layer | State |
|---|---|
| Core types (zod), resolver, engine, report | ✅ working + tested |
| Filesystem registry (semver, cached) | ✅ working + tested |
| CLI (`run`, `block add/list`, `validate`, `schema`, `context`, `report`) | ✅ working |
| Agent interface (catalog + schema + guide + validate) | ✅ working |
| MCP server (`aart mcp`, 7 tools) | ✅ working (verified over stdio) |
| Capability model + native pack blocks | ✅ working |
| QA pack — `qa.api.*`, `qa.assert.*`, `qa.browser.*` (Playwright) | ✅ working (verified incl. real Chromium) |
| `node` block executor | ⚠️ temporary (`node:vm`, **not a sandbox**) |
| Approval gate / governance | 🚧 Phase 4 |
| Block-code static-analysis gate | 🚧 Phase 5 |

## Quick start

```bash
npm install

# register two example blocks, then run the example workflow
npm run dev -- block add examples/blocks/echo.block.yaml
npm run dev -- block add examples/blocks/upper.block.yaml
npm run dev -- run examples/workflows/echo-smoke.workflow.yaml --input '{"start":"hello"}'

npm test          # run the unit + engine tests
```

Expected: the workflow runs `echo → upper`, prints a per-step trace, returns
`{ "final": "HELLO" }`, and writes a report to `.aa/runs/<id>/run.json` (replay
it with `npm run dev -- report <id>`).

Once built (`npm run build && npm link`) the command is just `aart`.

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
  core/        types, engine, context, resolver, report, executor, run-service
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
