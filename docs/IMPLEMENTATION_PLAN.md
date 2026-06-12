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
- **Generation is done by the calling CODING AGENT** (Claude Code, Codex,
  OpenCode, …), **not by an embedded LLM.** aart never calls Ollama/OpenAI. The
  agent is the author; aart makes it *aware of what & how* (catalog + schema +
  guide), validates its drafts, governs approval, executes deterministically,
  and returns a structured report the agent iterates on.
- **Human approval is a first-class gate**, not an afterthought.
- Filesystem state under `.aa/` — **no database**.

### The generation model (important correction, 2026-06-09)

The original report imagined `aart generate` calling a local LLM. That is **out**.
Instead the loop is:

```
coding agent  → discovers blocks (aart blocks / aa_list_blocks)
              → learns how to author (aart context / aa_get_schema + instructions)
              → drafts a workflow/block (the agent IS the LLM)
aart          → validates the draft (aa_validate)
human         → approves
aart          → registers (aa_register_block), runs deterministically (aa_run_workflow)
              → returns the structured evidence report
coding agent  → reads the report, revises, repeats
```

aart's surface for this: an **MCP server** (`aart mcp`) and equivalent **CLI
affordances** (`blocks --json`, `schema`, `validate`, `context`). No LLM provider
abstraction is needed anywhere.

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
| 12 | Generation | **done by the calling coding agent**, not an embedded LLM. aart exposes catalog/schema/guide + validate/run/report via CLI + MCP. No Ollama. |

---

## 3. Open decisions — resolve before the phase that needs them

| Decision | Needed by | Notes |
|---|---|---|
| **Sandbox tier** for `node` blocks | Phase 5 (block code gen) | `isolated-vm` vs restricted runtime vs Docker-optional. Today: `node:vm`, explicitly **not** a security boundary. This is the critical fork — the executor interface depends on it. |
| **Determinism / dependency pinning** | Phase 3+ | Legacy did runtime `npm install` with `*` versions (non-deterministic + RCE). Decide: lockfile per block? prebuilt envs? vendored deps? |
| **Capability / Policy model scope** | Phase 3 | Minimal capability-gating that lets the QA pack run safely without stalling the dogfood. The whole *govern* pillar is greenfield. |
| **Static-analyzer: harden vs replace** | Phase 5 | Legacy one is single-pass (false-positives on hoisted code) and was never called. Move to `ts.createProgram` + type checker, or replace. The coding agent authors the code, but aart must still vet it before it runs. |
| **Approval gate mechanics** | Phase 4 | How does the human approve an agent's draft — a CLI `--yes`/interactive prompt, a registry `draft`/`approved` state, or both? `aa_register_block` currently registers on validate. |

---

## 4. Salvage map (from the legacy `~/code/aa` analysis)

| Capability | Legacy file | Verdict | New home |
|---|---|---|---|
| Unified recursive Block/Workflow model | `models/types.ts` | port concept (→ zod, split ctx, ordered trace) | `core/types.ts` ✅ |
| Interpreter (recurse, `if/then/else/next`, refs) | `engine.ts` | port concept (split exec/persist/resolve) | `core/engine.ts` ✅ |
| Snapshot + per-step trace = evidence report | `engine.ts`, `ExecutionResult` | port concept | `core/report.ts` + `types.ts` ✅ |
| Filesystem YAML registry + versioning | `registry.ts` | reuse code (fix semver, add cache) | `registry/file-registry.ts` ✅ |
| Block executor contract + `inputs/outputs.json` ABI | `executors/` | port concept (drop in-process dev path) | `core/executor.ts` (temp) |
| AI plan→generate + JSON contracts | `llm-client.ts` | **drop the embedded LLM** — the coding agent authors. Keep the JSON contracts as the agent's schema/guide. | `agent/guide.ts`, `agent/schema.ts` |
| Static-analysis guardrail | `static-analyzer.ts` | port concept (harden; actually gate writes) | `agent/validate.ts` |
| Builder FSM + approval gates | `chat-service.ts`, web `GlobalChat` | port concept (→ the agent loop + a human approval gate) | `agent/guide.ts`, MCP tools |
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
- [x] two-phase write (RUNNING on start → terminal on completion) for crash-visibility
- [ ] `aart run` resolves a top-level run as authoritative (no sibling run rows — legacy bug)

### Phase 2 — Artifact store `[x]`
- [x] `artifacts/artifact-store.ts` under `.aa/runs/<id>/artifacts/`
- [x] structured first-class artifact metadata (`type`, `stepId`, `path`) in the run record

### Phase 2.5 — Agent-author interface `[x]` (brought forward)
The agent-callable surface that makes a coding agent "aware of what & how".
- [x] `agent/guide.ts` — the authoring guide (single source; reused by CLI, MCP, docs)
- [x] `agent/catalog.ts` — machine-readable block catalog from the registry
- [x] `agent/schema.ts` — JSON Schema for a definition (via zod-to-json-schema)
- [x] `agent/validate.ts` — schema + workflow-ref validation (the registration gate)
- [x] CLI: `blocks --json`, `schema`, `validate`, `context`; `block add` validates before saving
- [x] **MCP server** (`aart mcp`): `aa_list_blocks`, `aa_get_block`, `aa_get_schema`,
      `aa_validate`, `aa_register_block`, `aa_run_workflow`, `aa_get_report`;
      `instructions` = the authoring guide. Verified over stdio JSON-RPC.
- [x] `aart run --json` — machine-readable run output for scripting/agent loops

### Deferred from the 2026-06-09 adversarial review
Fixed in that pass: `{{ctx.secrets.x}}` removed from the guide (engine `ctx` scope
now consistent across step inputs / conditions / outputMapping); self-referencing
& bad-version workflows rejected at validation; inline/file runs now go through the
same ref-check gate as registration; MCP `aa_run_workflow` got an `outputSchema`, a
`version` param, a lean snapshot-free wire view, and a guarded register write; the
MCP registry is built once (cache survives calls). Still deferred:
- [ ] **Secret wiring** — secrets are only readable inside `node` code via
      `ctx.secrets`; step-input interpolation of secrets is intentionally absent
      until a secrets source + leak-into-trace policy is decided (Phase 4).
- [ ] **Snapshot completeness** — `buildSnapshot` silently skips an unresolved ref
      on an untaken branch; low-risk now that runs are gated, but add a
      `missing[]` evidence field when convenient.

### Phase 3 — QA pack `[x]`
- [x] Capability model: packs register capabilities into `ctx.capabilities`,
      set up/torn down per run, only when a run needs them (`collectCapabilities`)
- [x] Native blocks + `CompositeRegistry` (pack blocks layered over the file
      registry; discoverable in the catalog, not written to `.aa`)
- [x] `Runtime` wires packs + capability lifecycle (CLI & MCP both use it)
- [x] Playwright `browser` capability (lazy import; launch/teardown per run)
- [x] Primitive blocks: `qa.browser.goto/click/fill/text_visible/screenshot`,
      `qa.api.request`, `qa.assert.equals/contains`
- [x] Screenshot artifacts wired to the artifact store + run report
- [x] Verified: api→assert workflow green; real-Chromium browser workflow green
      end to end via the CLI (screenshot artifact + report)
- [x] Browser console and network request artifacts captured per step
- [ ] Playwright trace.zip capture — **deferred** (heavyweight; per-step
      screenshot + console/network already cover the primary evidence need)
- [ ] a real coding agent authoring a QA workflow via MCP is the live dogfood

### Pre-dogfood hardening `[x]` (2026-06-09)
From the dogfood-readiness audit (flow trace + WSL2 portability + capability gap):
- [x] **Workspace override** — `--workspace` flag + `$AART_WORKSPACE`; resolution order:
      `--workspace` → `$AART_WORKSPACE` → nearest ancestor `.aa` → `~/.aart`
      (implemented in `src/cli/workspace.ts`; `aart mcp` logs the resolved path on startup)
- [x] **`aart` available** — `prepare` builds `dist/` on install; clean build drops stale files
- [x] **Secrets** — `{{secrets.NAME}}` from `AART_SECRET_*` / `.aa/secrets.json`, resolved at
      run time and **redacted** from the report (no plaintext credentials on disk) — login is now safe
- [x] **WSL2** — README section (`playwright install --with-deps chromium`, networking/URL
      guidance, keep repo off `/mnt/c`); friendlier Chromium-launch error pointing at the fix
- [ ] nice-to-have: headed/visible mode (WSLg or CDP-connect to a Windows browser);
      `wait_for_url`/`selector_visible` blocks

**Secret redaction is best-effort defense-in-depth, not a hard boundary** (hardened in the
review pass: masks verbatim + JSON/URL-encoded forms, longest-first, node-block logs redacted,
raw `ctx.secrets` no longer handed to `node:vm` code). Residual, documented limitations:
- artifact CONTENTS (screenshots) are not scrubbed — use the screenshot `mask` option;
  browser console/network artifact **contents** are now also secret-masked.
- other transforms (base64/hash/partial reflections) can still slip through.

**Decision: reference-aware secret redaction was evaluated and decided against.** The
all-secrets mask is safer than reference-tracking (which could under-redact if a value is
aliased). Instead, console and network artifact contents are now masked using the same
all-secrets pass. Treat the run dir as low-sensitivity, not secret-free.

**OS-delegated scheduling** — `aart schedule` registers recurring runs via the host OS
scheduler (launchd on macOS, cron on Linux). No embedded daemon or always-on server.

**Opt-in failure notifications** — configure `.aa/notify.json` to receive OS or webhook
alerts when a run fails.

**Dogfood status: GO** — full author→validate→register→run→report loop verified live on CLI + MCP
with real Chromium; secrets redacted; portable to macOS + WSL2.

### Phase 4 — Governance: the approval gate `[x]`
- [x] Registry lifecycle state `draft → approved → deprecated` on the definition;
      every registration (CLI `block add` + MCP `aa_register_block`) lands as **draft**
- [x] Human-only `aart approve` / `aart deprecate` / `aart show` (no MCP approve tool)
- [x] Run gate (transitive over referenced blocks; native blocks pre-trusted):
      CLI `aart run` refuses an unapproved def unless `--yes` (one-time human override);
      MCP `aa_run_workflow` refuses any unapproved def and all inline defs
- [x] Run report records `approved` (a `--yes` run is flagged ⚠ UNAPPROVED); catalog
      shows each block's `status`; guide/AGENTS document the protocol
- **Honest scope:** a real boundary for an MCP-constrained agent + an audit trail;
  a *shell-capable* agent can call `aart approve` itself, so it is deliberate-action
  governance, not a hard security control. (Hardening it further ties into Phase 5.)

### Phase 5 — Block-code safety for agent-authored `node` blocks `[x]`
- [x] **Real sandbox** — `node` blocks run in `isolated-vm` (a true V8 isolate:
      own heap, NO host refs, so the `process`/`require` escape that defeats
      `node:vm` is gone). Enforces a memory limit and a HARD timeout (a runaway
      loop is terminated, not abandoned). Fresh isolate per run (no cross-block
      contamination) + cross-isolate V8 compile cache for speed.
- [x] node blocks are pure compute: `inputs` + `ctx`{runId,vars} in as copies,
      JSON-serializable object out; NO capabilities/secrets (can't cross an
      isolate — capability work stays in native pack blocks). Verified: the
      secret-exfil-via-`process.env` block that worked under `node:vm` now fails.
- [x] **Static gate** — a node block's code must compile (isolated-vm
      `compileScriptSync`) to be registered (`validateDraft`).
- decision settled: sandbox tier = `isolated-vm` (in-process, ms-scale, no Docker).
  It's a native addon but ships **prebuilt binaries** for macOS-arm64, Linux
  x64/arm64 (incl. WSL2), Windows-x64 on recent Node — so `npm install` needs no
  compiler there (only Intel mac / odd ABIs build from source). Made an
  **optionalDependency + lazy-loaded**, so install never fails and QA-only usage
  works without it.
- **Node-policy decision** — `package.json` `engines: >=20` is accurate: the
  published `dist/` runs on Node 20 (sandbox absent, `node` blocks unavailable).
  Building from source also works on Node 20, because the build resolves
  isolated-vm types from a **vendored stub** (`src/types/isolated-vm.d.ts`) rather
  than the real addon's `.d.ts` (which requires node>=22 to install). The stub
  shadows the real types on all platforms; runtime correctness on Node 22 is
  verified by the test suite. CI has a dedicated `build-node20` job that proves
  the Node-20 build path.

### Post-dogfood UX (2026-06-09, from real usage) `[x]`
First real MCP session surfaced friction; fixed:
- **Conversational approval** — added `aa_approve` / `aa_deprecate` MCP tools so the
  agent records approval after the **user agrees in chat** (no terminal). Default on;
  `AART_STRICT_APPROVAL=1` restores the CLI-only out-of-band gate. (Supersedes the
  Phase-4 "no MCP approve tool" stance — the user found that too heavy.)
- **Agent does everything via tools** — added `aa_list_runs`; sharpened tool
  descriptions; rewrote the guide as a directive recipe with a worked example so the
  agent knows the register→approve→run loop (esp. registration). The user shouldn't
  type `aart` commands.
- **Onboarding** — `aart doctor` (checks Node/isolated-vm/Playwright with fix hints);
  README leads with `npm i -g @team-monet/aart` (PATH) + "just ask the agent".
- **Terminology** — "human" → "user" throughout user/agent-facing text.
- **Read-only dashboard** — `aart dashboard` serves a local read-only web UI
  (127.0.0.1 only): block catalog with approval status, run history, per-step
  traces, artifacts, and workspace-pack status. **Scoped exception** to the
  "no web UI in MVP" guardrail: it is read-only inspection only (no authoring,
  no approval — those remain in the governed chat/CLI flows). It does not
  contradict the guardrail against building an authoring UI.

### Distribution `[x]`
- [x] **npx / npm**: `files: ["dist","examples"]` (no src/docs leak), `prepare` builds dist,
      `prepublishOnly` runs typecheck+tests; isolated-vm optional → `npx aart mcp` works
      with no clone and no toolchain on common platforms. Verified: pack contents clean,
      bin runs, QA path works without isolated-vm. See docs/PUBLISHING.md.
- [x] **Published**: `@team-monet/aart` is live on npm (0.6.0 shipped; 0.7.0 in progress).
- [x] **CI/CD + OIDC trusted-publish**: `.github/workflows/publish.yml` publishes
      automatically on GitHub Release via npm Trusted Publishing (OIDC, `id-token: write`
      permission). **No `NPM_TOKEN` secret** is stored anywhere. CI has two jobs:
      `build-node20` (proves build-from-source on Node 20 via the isolated-vm stub) and
      `test` (full suite on Node 22 with the real isolated-vm addon). See docs/PUBLISHING.md.
- [ ] later: Docker image (GHCR) for zero-toolchain "any laptop with Docker".
- [ ] later: deeper static analysis (reference/output-type inference, the legacy
      analyzer concept) — lower priority now that the sandbox is the hard boundary.
- [ ] later: marketplace GitHub Action — deferred.

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
