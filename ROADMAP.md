# aart Roadmap

aart is OSS infrastructure: a framework for AI coding agents to author reusable, governed, evidence-producing automation that deploys directly to production and runs in any environment — with no separate tool, GUI, or new product surface.

## Why this roadmap

aart's bet: the AI agent should be the **author** of durable automation, not just an executor of human-built workflows — and agent-authored automation reaches production only when it's deterministic, governed, and produces evidence. aart extends the tools you already use (your coding agent, MCP, npm, OCI) rather than adding a new platform. This roadmap closes the gap from "the agent can author and verify automation locally" to "that automation is reusable, deployed, and running in any environment."

## Where aart is today

The **authoring loop is solved**. An agent can discover blocks (`aa_list_blocks` / `aa_find_blocks`), draft and validate a workflow (`aa_validate`), register it into the approval lifecycle (draft → approved → deprecated via `aa_approve` / `aa_deprecate`), and run it deterministically in a sandboxed V8 isolate with per-block timeouts, memory limits, and concurrency caps. Every run produces a structured evidence report — per-step trace, inputs/outputs, screenshots, artifacts — stored under `.aa/runs/<runId>/run.json`. A local dashboard (`aart dashboard`) surfaces the block catalog, run history, and inline evidence. Agents can reference credentials safely via `{{secrets.NAME}}` (from `AART_SECRET_*` env vars or `.aa/secrets.json`), use governed CLI blocks (`command` type: fixed binary + argv template, spawned without a shell, every execution in run history), schedule recurring runs via `aart schedule` (cron-backed), and receive post-run webhook notifications via `.aa/notify.json` (Slack or generic). Block and workflow definitions are versioned YAML files (`.aa/blocks/<id>_v<version>.yaml`); the registry is a `CompositeRegistry` layering native pack blocks over the user's file registry — no database.

What's missing is everything *after* "the agent built it locally." Automations can't easily leave the local `.aa/` workspace, rely on hand-installed cron for scheduling rather than a managed execution surface, and require Node.js plus native addons installed on the host. Retry and idempotency must be hand-authored today. In short: **authoring is solved; distribution, production execution, and portability are the gap.**

---

## Roadmap

Four phases. Phase 1 is the near-term focus. These are themes of intent, not dated releases.

### Phase 1 — Runs in production, unattended

**Goal:** an agent-authored workflow runs reliably in production without a human at a terminal.

- **Container image (Docker / GHCR)** — a zero-toolchain portable runtime to drop into CI, a server, or Kubernetes. This is the highest-leverage single item: it also advances portability and enables distribution without requiring Node.js + native addons on the target host.
- **`aart serve`** — a long-lived mode exposing HTTP/event triggers and in-process scheduling, moving beyond one-shot CLI and hand-installed cron. Unattended runs need a first-class host process, not a terminal session.
- **Reliability primitives** — built-in retry with backoff, idempotency keys, and explicit mid-workflow failure semantics. Per-block timeouts, memory limits, and concurrency caps already exist; retry must currently be hand-authored. These belong in the runtime, not in every workflow that needs them.

### Phase 2 — Reusable beyond one workspace

**Goal:** an automation authored in one place is installable and reusable anywhere.

- **Publish / pull for blocks and workflows**, riding existing registries (npm or OCI) rather than a bespoke hosted registry. Agent-authored automation should be a shareable artifact, not a `.aa/` directory copy.
- **Namespacing (org/team scopes)** so cross-team reuse doesn't collide on a flat registry.
- **Dependency pinning / lockfiles** for workflows that compose other blocks — reproducible behavior across environments requires pinned dependencies.
- **A portable, documented block/workflow format** — so automations are an open, interoperable artifact rather than runtime-specific state.

### Phase 3 — Any environment, safely

**Goal:** the same automation runs across environments with the right credentials and the trust needed for production.

- **Per-environment config + pluggable secrets backends** (e.g. Vault, cloud secret managers) + per-environment policy. Today secrets are workspace-local; production requires secrets that live in managed stores and policies that vary by environment.
- **Environment promotion and stage gates** — approval is sought once per artifact and at each environment boundary (e.g. approved for staging; promoting to production needs separate sign-off), **not for every step the agent takes at runtime**. Once an automation is approved for an environment it runs unattended there, and the evidence report — not a stream of runtime prompts — is how you see what it did. This is the trust layer that makes agent-authored automation safe to run in production without per-action friction.
- **Production observability** — structured logs, a metrics / OpenTelemetry endpoint, and failure alerting, layered on the existing run records and post-run webhook notifications.

### Phase 4 — Adoption and authoring experience

**Goal:** make aart effortless to author for and reachable from any agent.

- **Authoring DX** — templates and scaffolding, lint / best-practice checks, and optional editor (LSP) support for block and workflow definitions.
- **Cross-workspace / multi-host catalog** — blocks discoverable beyond a single workspace; a shared catalog surface that doesn't require a separate hosted service.
- **Broader agent host support** — deepen MCP-native interop and broaden from coding agents toward any agent host that can drive aart's MCP interface.

---

## Design principles

- **Ride existing ecosystems** — OCI, npm, MCP, OpenTelemetry, existing secret managers. Extend what developers already have rather than replacing it.
- **No new interface** — author through the agent's existing flow (CLI + MCP); don't grow a separate console or GUI.
- **Deterministic, governed, and evidence-producing by default** — these are first-class properties, not add-ons.
- **Approve the artifact, not every step** — trust is established once, when an automation and the blocks it composes are approved, and again at environment-promotion boundaries — never as a per-step prompt during a run. Up-front approval plus a full evidence trail replaces per-action approval, so automations run unattended in production without friction.
- **Portable, open artifacts over lock-in** — a block or workflow is a YAML file on a filesystem; it should be readable, shareable, and inspectable without the runtime.
- **Coding-agent-first today; any-agent over time** — the current surface is optimized for coding agents (Claude Code, Codex, Cursor); the MCP interface is the right abstraction to broaden that over time.

## Non-goals

- **No embedded LLM** — generation is done by the calling agent; aart is and stays the deterministic runtime.
- **No hosted product or paywall** — aart is OSS infrastructure.
- **No separate GUI or console to learn** — the agent's existing chat + CLI flow is the interface.
- **No ungoverned shell-out** — host commands run through the governed, audited `command` path; the binary and argv template are part of what the user approves.
- **No per-step runtime approval** — a running automation isn't interrupted to confirm each action; approval happens at authoring and promotion, and execution is then unattended, with evidence captured for review after the fact.
