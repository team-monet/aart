# Portable AA Runtime + QA Pack + AI Workflow Generation — Implementation Plan

**Project:** aart (Agentic Automation RunTime)
**Status:** active — Phase 0 skeleton landed
**Source of truth for strategy:** `~/Obsidian/03_Projects/Agentic-Automation/reports/2026-06-08__aa-runtime-market-architecture-and-mvp-direction__coda.md`
**Legacy reference (read-only):** `~/code/aa` (the prototype this replaces)

This is the living build tracker (the role `product_design.md` played in the old
repo). Update the checkboxes as work lands.

Legend: `[ ]` proposed · `[/]` in progress · `[x]` done

---

## 1. Thesis & guardrails

> AI creates reusable automation blocks & workflows. Humans govern them. A
> portable runtime executes them deterministically. Reports prove it.

- Core is a **generic** automation runtime. **QA is the first pack**, not the core.
- **CLI first, MCP second.** No web UI in the MVP.
- **AI generation from day 1** — but AI produces *artifacts*; the runtime executes
  *deterministically*. The two never mix.
- **Human approval is a first-class gate**, not an afterthought.
- Filesystem state under `.aa/` — **no database**.

**Explicitly avoid** (these are what the legacy code became): building a UI first,
a QA-only engine, hand-authored workflows, AI improvising execution each run,
untrusted code running in-process, an always-on server/daemon.

---

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Repo | **fresh** at `~/code/aa-runtime`; legacy `~/code/aa` kept read-only as reference |
| 2 | CLI / package name | **`aart`** |
| 3 | Language | TypeScript |
| 4 | Module system | CommonJS for now (no ESM-extension friction); revisit if needed |
| 5 | Definitions store | filesystem YAML registry (`.aa/registry/blocks/<id>_v<version>.yaml`) |
| 6 | Run store | filesystem JSON (`.aa/runs/<runId>/run.json`) — no DB |
| 7 | Core model | a workflow **is** a Block with `execution.type==='workflow'` (one recursive type) |
| 8 | Context model | `inputs` ≠ `params` ≠ `ctx` are separate, first-class |
| 9 | Trace | an **ordered array** with seq indices (not the legacy id-keyed Record) |
| 10 | Conditions | a **safe comparator**, never `new Function`/`eval` |
| 11 | Ids | `crypto.randomUUID()` (not legacy `shortid`) |

---

## 3. Open decisions — resolve before the phase that needs them

| Decision | Needed by | Notes |
|---|---|---|
| **Sandbox tier** for `node` blocks | Phase 5 (block code gen) | `isolated-vm` vs restricted runtime vs Docker-optional. Today: `node:vm`, explicitly **not** a security boundary. This is the critical fork — the executor interface depends on it. |
| **Determinism / dependency pinning** | Phase 3+ | Legacy did runtime `npm install` with `*` versions (non-deterministic + RCE). Decide: lockfile per block? prebuilt envs? vendored deps? |
| **LLM provider + structured output** | Phase 4 | Real provider abstraction (legacy was hardwired Ollama-via-OpenAI-SDK). Native structured outputs vs a zod-repair loop. |
| **Capability / Policy model scope** | Phase 3 | Minimal capability-gating that lets the QA pack run safely without stalling the dogfood. The whole *govern* pillar is greenfield. |
| **Static-analyzer: harden vs replace** | Phase 5 | Legacy one is single-pass (false-positives on hoisted code) and was never called. Move to `ts.createProgram` + type checker, or replace. |
| **Approval state model** | Phase 4 | Add `draft`/`approved`/`deprecated` to the registry now, or later? |

---

## 4. Salvage map (from the legacy `~/code/aa` analysis)

| Capability | Legacy file | Verdict | New home |
|---|---|---|---|
| Unified recursive Block/Workflow model | `models/types.ts` | port concept (→ zod, split ctx, ordered trace) | `core/types.ts` ✅ |
| Interpreter (recurse, `if/then/else/next`, refs) | `engine.ts` | port concept (split exec/persist/resolve) | `core/engine.ts` ✅ |
| Snapshot + per-step trace = evidence report | `engine.ts`, `ExecutionResult` | port concept | `core/report.ts` + `types.ts` ✅ |
| Filesystem YAML registry + versioning | `registry.ts` | reuse code (fix semver, add cache) | `registry/file-registry.ts` ✅ |
| Block executor contract + `inputs/outputs.json` ABI | `executors/` | port concept (drop in-process dev path) | `core/executor.ts` (temp) |
| AI plan→generate + JSON contracts | `llm-client.ts` | port concept (zod + retry, provider layer) | `ai/generators.ts`, `ai/prompts.ts` |
| Static-analysis guardrail | `static-analyzer.ts` | port concept (harden; actually gate writes) | `ai/validators.ts` |
| Builder FSM + approval gates | `chat-service.ts`, web `GlobalChat` | port concept (→ CLI y/N, MCP results) | `cli/commands/generate.ts` |
| Triggers (cron/file-watch) | `trigger-engine.ts` | reference only (post-MVP) | — |
| Docker compiler / omni-container | `compiler.ts`, `worker.ts` | reference only | — |
| SQLite persistence | `db.ts` | **drop** | `.aa/runs/*.json` |
| ChromaDB RAG | `rag-service.ts` | **drop** (inject blocks into prompt) | — |
| Express REST + API-key auth | `server.ts`, `routes/*` | **drop** (verbs → CLI; MCP replaces) | — |
| React/Monaco web app | `web/` | reference only (mine UX flows) | — |
| dependencyParser, shortid | `utils/*` | **drop** (buggy / deprecated) | — |

---

## 5. Build order

### Phase 0 — Skeleton `[x]`
- [x] Fresh TS repo, target `src/` layout, `tsx` + `vitest` + `zod` + `commander` + `yaml`
- [x] `aart --help` runnable
- [x] `.gitignore`, `tsconfig`, `.nvmrc`, README, this plan

### Phase 1 — Core runtime `[/]`
- [x] `core/types.ts` — zod schemas; ordered trace; `inputs/params/ctx` split
- [x] `registry/file-registry.ts` — ported, real semver, cache (+ tests)
- [x] `core/resolver.ts` — `{{interp}}` + nested `$ref`, throws on miss, safe `if` (+ tests)
- [x] `core/engine.ts` — recursive interpreter, control flow, snapshot, trace (+ e2e test)
- [x] `core/executor.ts` — in-process `node:vm` executor with a real timeout *(temporary)*
- [x] `core/report.ts` + `.aa/runs/<id>/run.json` writer + `aart report`
- [ ] two-phase write (RUNNING on start → terminal on completion) for crash-visibility
- [ ] `aart run` resolves a top-level run as authoritative (no sibling run rows — legacy bug)

### Phase 2 — Artifact store `[/]`
- [x] `artifacts/artifact-store.ts` under `.aa/runs/<id>/artifacts/`
- [ ] artifact metadata in the run record (type, step, path) as first-class evidence

### Phase 3 — QA pack `[ ]`
- [ ] Capability model: packs register capabilities into `ctx.capabilities`
- [ ] Playwright `browser` capability lifecycle (launch/teardown per run)
- [ ] Primitive blocks: `qa.browser.goto/click/fill/text_visible/screenshot`, `qa.api.request`, `qa.assert.equals/contains`
- [ ] QA artifacts (screenshot/trace/console/network) wired to the artifact store
- [ ] First dogfood workflow runs green end to end

### Phase 4 — AI workflow generation (L1) `[ ]`
- [ ] `ai/provider.ts` — real provider abstraction (OpenAI / local Ollama / …)
- [ ] `generateWorkflow(request)` — list blocks → draft → **zod-validate + repair loop**
- [ ] `aart generate` — preview the plan, require explicit approval, then register + run
- [ ] reject workflows referencing unknown blocks at generation time (legacy failed at run time)

### Phase 5 — AI block generation (L2/L3) `[ ]`
- [ ] `generateBlockSpec` (L2) — spec only, human-confirmed
- [ ] `generateBlockCode` (L3) — code draft **gated by a hardened static analyzer**
- [ ] real sandbox tier replaces `node:vm` (see open decision)
- [ ] approval state in the registry (`draft`/`approved`/`deprecated`)

### Phase 6 — MCP `[ ]`
- [ ] MCP server exposing `aa.list_blocks`, `aa.generate_workflow`, `aa.run_workflow`, `aa.get_report`, `aa.propose_block`
- [ ] coding agents call the runtime and receive structured reports

---

## 6. Week 1 — concrete tasks

1. [x] Scaffold the repo; `aart --help` runs.
2. [x] `core/types` as zod (ordered trace, ctx split).
3. [x] Port `FileRegistry` with real semver + cache; carry the registry test.
4. [x] `core/resolver` pure fn (nested `$ref`, explicit misses); test the legacy cases.
5. [x] `core/engine` over the in-process executor with a real timeout + safe `if`; echo workflow runs via `aart run`.
6. [x] `core/report` + `runs/` writer + `aart report`.
7. [/] Architecture note pinning the open decisions (this doc's §2–3) so weeks 2+ don't relitigate.

---

## 7. Success criteria

**MVP v0.1 (the report's bar):** John asks, in natural language, "log in and check
the dashboard shows up"; `aart` drafts a workflow from QA-pack blocks, previews it
for approval, runs it deterministically, and leaves a screenshot + structured report.

**Phase 1 (now):** `aart run examples/workflows/echo-smoke.workflow.yaml
--input '{"start":"hello"}'` returns `{ "final": "HELLO" }` with a per-step trace
and a replayable `run.json`. ✅
