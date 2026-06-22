# aart Architecture

Contributor reference for the aart automation lifecycle. This document is grounded in the current codebase; every referenced symbol has been verified against the files named. Cross-reference [PRODUCT.md](PRODUCT.md) for the product view and [ROADMAP.md](ROADMAP.md) for delivery sequencing.

---

## Overview

aart extends its existing deterministic block/workflow runtime to cover a full automation **lifecycle**: author → validate → test → approve → promote → deploy → run autonomously. The extension is additive:

- Every new `BlockDefinition` field is `optional()` in the Zod schema — no migration required.
- All new state is filesystem-native under `.aa/` — no database.
- The engine (`Engine`), resolver, redaction, and `CompositeRegistry` resolution order are untouched.
- `ExecutionSnapshot` (built by `Engine.buildSnapshot`) is reused by the closure compiler; nothing changes there.

The principle from ROADMAP.md holds: aart rides existing ecosystems (npm, OCI, OpenTelemetry, existing secret managers) and adds no new GUI or console surface. The calling agent is always the author; aart is and stays the deterministic runtime.

---

## The Lifecycle as a State Machine

```
draft → approved → promoted(env) → deployed(env) → [deprecated]
```

Every transition is a filesystem write. Rollback means re-promoting the prior approved artifact. Each boundary is a filesystem gate.

| Stage | Existing components | New components |
|---|---|---|
| DEVELOP | `aa_register_block`, `AUTHORING_GUIDE`, `validateDraft`, `FileRegistry` (registration lands `draft`) | Deepened static analysis; readiness record |
| VALIDATE | `validateDraft` (schema, reference resolution, node syntax via isolate, regex, default/enum/pattern) | Opt-in `deep` pass: output-type inference + data-flow reachability |
| TEST | `Runtime.run` → `Engine` → per-step trace → `RunRecord` at `.aa/runs/<id>/run.json`; `aa_verify`; dashboard; artifact store | `aa_test` / `aart test` writes a readiness record; `aart status <id>` |
| APPROVE | `aa_approve` / `aa_deprecate`, transitive `unapprovedInTree` / `deprecatedInTree` walk, `AART_REQUIRE_APPROVAL` opt-in enforcement, deprecation always-on | `aa_approve` surfaces the readiness record; promotion gate at env boundaries |
| DEPLOY | — | `aart package` (closure compiler) → portable bundle; `ManifestRegistry`; `aart serve` |
| AUTONOMOUS RUN | One-shot run, `aart schedule` (OS cron), post-run `notify`, timeout / memory / concurrency caps | `aart serve` long-lived trigger engine; retry / idempotency; structured logs + optional OTel; per-env secrets |

---

## Front-Half Loop (Develop → Validate → Test → Approve)

This is the near-term focus. It operates entirely on existing runtime primitives plus the two additions described below.

### Existing validation pass

`validateDraft` (`src/agent/validate.ts`) runs on every `aa_register_block` call. It performs:

1. Schema validation against `BlockDefinitionSchema` (Zod, `src/core/types.ts`).
2. For `node` blocks: dependency well-formedness + syntax check via `checkNodeSyntax` (compiles inside the isolate) or `checkHostNodeSyntax` (for dependency-bearing blocks).
3. Input constraint validation: `enum` non-empty, `pattern` compiles as a regex, `default` satisfies enum/pattern.
4. For `command` blocks: binary is a fixed string (no `{{interpolation}}`), `cwd` is a fixed path.
5. For `workflow` blocks: `validateWorkflowRefs` — each step references a real (id, version) in the registry; no self-reference; reserved step ids (`loop`, `inputs`, `params`, `ctx`, `secrets`, `steps`) rejected; `forEach` cannot be combined with `if`/`then`/`else`/`next`.

### Deepened static validation (new — two-pass design)

A new optional `deep: true` parameter on `validateDraft` adds a second pass after the existing fast path. The fast path is unchanged; the deep pass is additive (warnings, not errors) and degrades gracefully when block `outputs` are undeclared.

**Output-type inference.** Cross-check `$stepId.field` consumers in a workflow's step inputs against the referenced block's declared `outputs` array (`FieldSchema[]`, `src/core/types.ts`). When a step wires `$prev.count` and the block `prev` declares `outputs: [{ name: "count", type: "number" }]`, the field is resolvable; when `prev` declares no outputs or the field name is absent, emit a warning. This catches wiring mistakes at validation time rather than at run time.

**Data-flow reachability.** Walk the workflow's control-flow graph: verify that every `then`/`else`/`next` target names an existing step id; detect steps that are unreachable from the entry step under any branch. Both conditions produce warnings (not errors) in the deep pass — a workflow with an unreachable step is still valid, just suspicious.

The deep pass never changes the `ok` field returned to the caller when only warnings are present, so no existing caller breaks.

### Readiness record

**Decision:** a separate file `.aa/readiness/<blockId>.json` — NOT a field on the block YAML. The block definition stays a pure, portable artifact; run-state lives beside it.

Shape:
```
{
  blockId:            string,
  version:            string,
  runId:              string,
  ranAt:              string (ISO),
  status:             "COMPLETED" | "FAILED",
  inputs:             Record<string, unknown>,
  consoleErrors:      number,
  invalidatedAt?:     string (ISO),
  approvalRequested?: string (ISO)
}
```

**Written by** `aa_test` (and its CLI twin `aart test`) after a clean local run. `aa_test` shares its execution path with `aa_run_workflow` — it calls `Runtime.run`, which calls the same `Engine`, and records the same `RunRecord` at `.aa/runs/<id>/run.json`. The only difference is the additional readiness file write.

**Invalidated** when the block is re-registered (mirrors the `approval → draft` reset that already happens on re-registration). When `registerBlock` lands an updated definition, if a readiness file exists for that `blockId`, set `invalidatedAt` to the current timestamp. This is the cheapest sentinel: a contributor who edits a block and re-registers it cannot accidentally claim the pre-edit run as evidence.

**Surfaced by:**
- `aa_approve` — shows the readiness record alongside the approval prompt, so the approver sees "last ran at X with these inputs, status COMPLETED, 0 console errors."
- `aart status <id>` (new CLI command) — shows approval status + readiness record + last run summary + unapproved deps (by reusing `unapprovedInTree`).
- Dashboard "ready" badge — a visual indicator on the block catalog entry; no new server route, just an extra field in the catalog response.

**What readiness is not:** it proves "this block ran with these inputs and produced no error." It does not prove correctness for all inputs or equivalent coverage. This should be stated in the authoring guide (`AGENTS.md` / `AUTHORING_GUIDE`).

---

## Environments and Promotion

### EnvironmentDefinition

Files at `.aa/envs/<name>.yaml` (one file per environment, matching the block-file pattern; VCS-friendly; secret *values* are never committed).

Shape:
```
{
  name:            string,
  secrets: {
    backend:       "local" | "env" | "vault" | "aws-secrets-manager" | "gcp-secret-manager",
    config?:       Record<string, unknown>   // backend-specific config (no values)
  },
  vars?:           Record<string, string>,
  requireApproval: boolean,
  policy?: {
    allowedBlockCategories?: string[],
    maxRunTimeoutMs?:         number
  }
}
```

`local` is implicit (the current workspace; `requireApproval` defaults to `false`). Any non-local environment **forces** `requireApproval: true` regardless of the `AART_REQUIRE_APPROVAL` env var — the promotion boundary is a hard gate.

### Promotion

Promotion is an explicit gate **separate** from artifact approval, consistent with the project's approval-granularity rule: approve at the artifact boundary and at the environment boundary, never per-step at runtime.

`aart promote <id> --env <name>` flow:
1. Reuse the existing `unapprovedInTree` walk — all blocks in the closure must be approved.
2. Check that a `PromotionRecord` for this (blockId, env) does not already exist for the same version.
3. Write a `PromotionRecord` at `.aa/envs/<name>/promotions/<id>_v<version>.json`:

```
{
  blockId:          string,
  version:          string,
  environment:      string,
  promotedAt:       string (ISO),
  promotedBy?:      string,
  requiresApproval: boolean,
  approved:         boolean,
  approvedAt?:      string (ISO),
  snapshotHash:     string    // sha256 of the closure snapshot
}
```

`aart promote` requires confirmation by default — promotion must not be conflated with artifact approval. When `requiresApproval` is `true` (all non-local envs), `approved` starts `false` and a separate `aart promote-approve <id> --env <name>` command (or the `aa_approve` MCP tool with an `env` parameter) sets it to `true`.

### Per-env secrets via a pluggable `SecretsBackend`

Interface:
```typescript
interface SecretsBackend {
  load(config: Record<string, unknown>): Promise<Record<string, string>>
}
```

The `local` backend is built-in (existing `loadSecrets` in `src/core/secrets.ts`, which reads `AART_SECRET_*` env vars and `.aa/secrets.json`). Other backends (`vault`, `aws-secrets-manager`, `gcp-secret-manager`) are optional peer dependencies that fail-fast at `aart serve` startup if the required package is missing — the same lazy-require pattern used for `isolated-vm`.

The engine still receives a resolved `Record<string, string>` secrets map at execution time — the resolver and redaction (`src/core/secrets.ts`) are untouched.

---

## Deploy Mechanism (Bundle-First)

**Decision:** the portable bundle is the **primitive**. A container image is an optional wrapper, never load-bearing. Docker is not required for the first deploy milestone.

### Closure compiler (`aart package`)

`ClosureCompiler` reuses the same dependency-closure walk as `Engine.buildSnapshot` (`src/core/engine.ts` lines 403–418), writing the result to disk rather than returning it in memory.

**Decision — closure pinning:** user-authored blocks are embedded verbatim in the bundle (their YAML is copied in full). Built-in pack blocks are referenced by `id@version` only — they ship with the runtime and are always available at serve time. This keeps the bundle small and avoids duplicating runtime code.

Output at `.aa/deployments/<deployId>/`:
- `manifest.json` — a `DeploymentManifest`:
  ```
  {
    deployId:              string,
    workflowId:            string,
    version:               string,
    environment:           string,
    closureHash:           string,    // sha256 of the full closure
    promotionRecordPath:   string,
    builtAt:               string (ISO),
    triggers:              TriggerDefinition[],
    envConfig: {
      vars?:               Record<string, string>,
      secretsBackend:      string,
      secretsConfig?:      Record<string, unknown>   // no values
    },
    runtimeVersion:        string    // @team-monet/aart version
  }
  ```
- `blocks/*.yaml` — the verbatim user-authored block definitions in the closure.

`closureHash` makes the bundle tamper-evident. A future `aart verify-bundle` command can recompute and compare.

### Primary artifact

A portable `.tar.gz` (manifest + `blocks/`) runnable via `aart serve --bundle <path>`. Optional: an OCI image wrapping the bundle (`FROM node:22-slim`, `npm i -g @team-monet/aart`, entrypoint `aart serve --bundle`). Both ride existing ecosystems.

### `ManifestRegistry`

A small read-only `Registry` implementation (satisfies the same `Registry` interface as `FileRegistry`, `src/registry/file-registry.ts`) backed by the bundle's `blocks/` directory. Substituted for `FileRegistry` at serve time. No engine change; version resolution is identical.

---

## Autonomous-Run Surface (`aart serve`)

**Decision:** one long-lived process hosts **multiple** workflows. The existing `MAX_CONCURRENT = 8` (isolate concurrency cap, `src/core/executor.ts`) and per-block `timeoutMs` already bound resource use. This matches the manifest model: a bundle declares its triggers; `aart serve` loads the bundle and dispatches them.

```
aart serve [--bundle <path>] [--env <name>] [--port <n>]
```

### `TriggerEngine` and `TriggerDefinition`

`TriggerDefinition` is a new discriminated union type:
```
type TriggerDefinition =
  | { type: "cron";    cron: string }
  | { type: "webhook"; path?: string; method?: string }
  | { type: "manual"  }
  | { type: "file";    watch: string }   // DEFERRED
```

Declared as an optional field on a workflow's `BlockDefinition` (so the definition remains portable and the current engine ignores it) and in the `DeploymentManifest`.

**Cron:** in-process scheduler. Recommend the `croner` or `node-cron` primitive rather than hand-rolling; the cron expression is stored in the trigger definition. `ScheduleRecord` (`src/core/schedule.ts`) is reused for run tracking; the `trigger` field on the schedule record accepts a back-compatible optional `{ type: "cron" }` annotation.

**Webhook / HTTP:** native `node:http` server (no framework dependency). Each workflow in the bundle with a `webhook` trigger gets a path; manual triggers accept `POST /run/<workflowId>`.

**File-watch:** deferred. The `TriggerDefinition` union includes the type so definitions are forward-compatible, but the dispatcher does not implement it in Phase 1B.

### `TriggerDispatcher`

Re-runs the same `unapprovedInTree` / `deprecatedInTree` gate (`src/core/approval.ts`) before each execution. This is the same gate that already fires in the one-shot CLI and MCP paths — the dispatcher is not a bypass.

Then calls `Runtime.run` exactly as the existing MCP `aa_run_workflow` handler does.

**Retry policy:**
```
RetryPolicy {
  maxAttempts: number,
  backoffMs:   number,
  retryOn:     ("FAILED" | "TIMEOUT")[]
}
```

Optional, declared per-trigger in the manifest. Each retry is its own `RunRecord` at `.aa/runs/<runId>/run.json`. The `notify` function (`src/core/notify.ts`) fires only on the **final** failure (not on intermediate retries). Re-runs the approval gate on each retry.

**Idempotency:** webhook callers may send `X-Idempotency-Key: <key>`. The dispatcher checks `.aa/idempotency/<key>.json` before dispatching; if it exists, return the cached `runId`. On first dispatch, write the file atomically (same rename pattern as `writeRun`) after the run completes.

### Observability

- Structured NDJSON to stdout when `AART_LOG_FORMAT=json`. Each log line includes `{ level, timestamp, runId?, blockId?, message }`.
- Optional OTel via `--otel-endpoint`: lazy-required (same pattern as `isolated-vm`) — `aart serve` starts without it; only a connection attempt loads the package.
- The local dashboard is unchanged. `aart serve` coexists with `aart schedule` (OS cron): both go through `Runtime.run`; `ScheduleRecord` is reused.

---

## Data-Model and State Changes

### Optional additions to `BlockDefinition`

New fields, all `z.optional()`:
```typescript
triggers?:     TriggerDefinition[]
environments?: Record<string, { promoted: boolean; promotedAt?: string; snapshotHash?: string }>
```

No existing field changes. `BlockDefinitionSchema` (`src/core/types.ts`) gains these with `.optional()`.

### Optional additions to existing record types

`RunRecord` (`src/core/types.ts`): optional `triggerId?: string` and `environment?: string` — back-compatible (absent on existing records).

`ScheduleRecord` (`src/core/schedule.ts`): optional `trigger?: { type: string }` — back-compatible.

### New filesystem artifacts

| Path | Purpose |
|---|---|
| `.aa/readiness/<blockId>.json` | Readiness record (per block, invalidated on re-register) |
| `.aa/envs/<name>.yaml` | EnvironmentDefinition |
| `.aa/envs/<name>/promotions/<id>_v<ver>.json` | PromotionRecord |
| `.aa/deployments/<deployId>/manifest.json` | DeploymentManifest |
| `.aa/deployments/<deployId>/blocks/*.yaml` | Closure blocks (user-authored only) |
| `.aa/idempotency/<key>.json` | Webhook idempotency record |

### State that does NOT change

- `BlockDefinitionSchema` existing fields
- The `approval` lifecycle (`draft` / `approved` / `deprecated`)
- `ExecutionSnapshot` structure and the `buildSnapshot` implementation
- `CompositeRegistry` resolution order (`native > packDef > file`)
- The V8 isolate sandbox (`isolated-vm`), its concurrency cap (`MAX_CONCURRENT = 8`), and the timeout / memory-limit contracts
- `loadSecrets` sourcing (`AART_SECRET_*` env vars + `.aa/secrets.json`)
- `writeRun` / `RunRecord` at `.aa/runs/<runId>/run.json`
- `resolveWorkspace` priority (`--workspace` flag → `$AART_WORKSPACE` → `~/.aart`)

---

## Risks and Mitigations

**1. Workspace-as-global-state in serve mode.** `writeRun`, `loadSecrets`, and `writeSchedule` all take an explicit `workspace: string` parameter — that is correct and must stay so. `aart serve --bundle <path>` needs a clearly established "serve workspace" for run records and idempotency files. Decision: default to the standard `resolveWorkspace()` resolution; `--workspace` overrides it. Document this explicitly in `aart serve --help`.

**2. `isolated-vm` is a native addon.** A bare bundle is not zero-native-dep for `node` blocks (the addon must be present on the host). The OCI image mitigates this by including the prebuilt binary. Pure browser/HTTP/data workflows (no `node` blocks) have no native-dep requirement and run anywhere `aart` installs.

**3. Promotion-approval UX must stay distinct from artifact approval.** The two gates serve different trust purposes. `aart promote` must require explicit confirmation; `aa_approve` (artifact approval) must not silently trigger promotion.

**4. Bundle staleness.** A deployed bundle is immutable by design — this is correct. `closureHash` enables a future `aart verify-bundle` to detect tampering or divergence from the live registry. Contributors should not rebuild a bundle in-place; create a new `deployId` instead.

**5. Readiness ≠ correctness coverage.** The readiness record proves "this block ran with these specific inputs and produced no error." It does not prove the block is correct for all inputs or that all branches were exercised. The authoring guide should state this plainly so approvers understand what the evidence does and does not guarantee.

**6. Pluggable secrets backends are peer deps.** Non-local backends (`vault`, `aws-secrets-manager`, `gcp-secret-manager`) must fail-fast at `aart serve` startup with a clear error if the required package is absent — not at first run. Same lazy-require pattern as `isolated-vm`; the error message must name the missing package and the install command.

---

## Sequencing

This is a summary; see [ROADMAP.md](ROADMAP.md) for the full sequencing rationale.

**Phase 1A — Front-half (immediate, no blocking decisions):**
- Readiness record + `aa_test` / `aart test`
- `aart status <id>` (approval + readiness + last run + unapproved deps)
- Deep validation pass (output-type inference + data-flow reachability)
- `aa_approve` surfaces the readiness record

**Phase 1B — Deploy and serve:**
- `EnvironmentDefinition` + promotion + `PromotionRecord`
- `ClosureCompiler` / bundle + `ManifestRegistry`
- `aart serve` (cron + HTTP triggers)
- Retry / idempotency
- Structured NDJSON logs + optional OTel

**Phase 2 — Distribution:**
- OCI image wrapper
- npm / OCI distribution
- Pluggable `SecretsBackend` (Vault, AWS, GCP)
- Closure lockfile

**Phase 3 — Cross-workspace:**
- File-watch trigger (deferred from Phase 1B)
- Cross-workspace catalog
