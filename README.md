# aart — Agentic Automation RunTime

> AI creates reusable automation blocks and workflows. Humans govern them.
> A portable runtime executes them deterministically. Reports prove it.

A governed **block/workflow runtime for AI agents**. The core is generic; QA is
the first pluggable pack (the dogfood wedge). CLI first, MCP second, no web UI.

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
| CLI (`run`, `block add/list`, `report`) | ✅ working |
| In-process executor | ⚠️ temporary (`node:vm`, **not a sandbox**) |
| AI generation (`generate`) | 🚧 stub — Phase 4–5 |
| QA pack (Playwright) | 🚧 stub — Phase 3 |
| MCP server | 🚧 — Phase 6 |

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
  core/        types, engine, context, resolver, report, executor
  registry/    file-registry (YAML on disk)
  artifacts/   artifact-store (evidence)
  cli/         commander entrypoint + commands
  ai/          prompts, validators, generators (stubs)
  packs/qa/    QA pack (stub)
examples/      runnable example blocks + workflows
```
