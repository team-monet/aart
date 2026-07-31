# @team-monet/aart

AART turns one successful agent task or existing reliable local command into
a reusable tool, block, or workflow that the same or another agent can
discover before rebuilding it. Humans co-author
and govern the asset; an AART server runs the approved version deterministically
without an agent in the execution loop. `@team-monet/aart` is the CLI over
that registry, engine, governance, and MCP surface.

AART lets you author, run, and govern multi-step workflows that mix deterministic blocks (HTTP, browser, file, data), LLM calls, and durable human-in-the-loop waits — with approvals, capability-based trust modes, redaction, and evidence capture built in rather than bolted on.

## Install

```sh
npm install -g @team-monet/aart
```

This installs the `aart` command. `npx @team-monet/aart <cmd>` works too,
for a one-off.

> **Requires `0.10.0` or later.** `@team-monet/aart` was already a claimed
> npm package name before this repository's current architecture existed —
> published versions `0.1.0` through `0.9.0` are a legacy, architecturally
> different release (a `commander`-based CLI with a different command
> surface entirely — no `aart mcp`/`aart bundle`/`aart deploy` as documented
> below). `0.10.0` is this repository's first npm release and carries the
> `latest` dist-tag, so a plain `npm install -g @team-monet/aart` now
> resolves correctly. If `aart --version` ever prints something other than
> `0.10.0` or later, or `aart --help` shows flags like `-w/--workspace` or
> a `doctor` command instead of what's documented below, you've landed on a
> stale pre-`0.10.0` install — run `npm install -g @team-monet/aart@latest`
> and re-check. See [`AUTHORING.md`](../../AUTHORING.md) at the repository
> root part (b) for the from-source path (contributors, or pinning an exact
> build) and the full history of this version gap.

## Quick start

```sh
# In an empty directory:
aart init                 # creates a local .aart project store

# Validate a workflow definition before running it:
aart validate ./my-workflow.json

# Register it, then trigger a run:
aart register ./my-workflow.json
aart run my-workflow-id --input '{"key": "value"}'

# List what's registered / what's run:
aart list
```

Every command prints a single JSON object (`{"ok": true, ...}` or `{"ok": false, "error": "..."}`) — designed to be scripted against as easily as read by a human.

## Command reference

```
aart run <workflowId> --input <json> [--version <v>]
aart report <runId> [--format model|markdown]
aart validate <path>
aart validate <workflowId> --registered [--version <v>]
aart list
aart find-tools [query] [--scope local|remote|all] [--index-url <url>]
aart tool register <manifest.yaml>
aart tool check <id> [--version <v>] [--input <json>]
aart tool run <id> [--version <v>] [--input <json>] --content-hash <sha256:...> --executable-hash <sha256:...> --argv-hash <sha256:...> [--prerequisite-hashes <json>]
aart tool report <toolrun_id>
aart find-blocks [query] [--category <category>] [--scope local|remote|all] [--index-url <url>]
aart find-workflows [query] [--category <category>] [--scope local|remote|all] [--index-url <url>]
aart pack search [query] [--index-url <url>]
aart pack add <name> [--version <v>] [--from <local-package-dir>]
aart pack list [--status unapproved|approved]
aart pack approve <name> --version <v> --content-hash <sha256:...> --reviewer <name>
aart pack prepare <local-package-dir> [--out <index-entry.json>]
aart register <path>
aart init
aart init-agent [--npx] [--package <name>] [--bin-path <path>] [--root <dir>] [--store fs|sqlite] [--cwd <dir>]
aart diff <workflowId> [--from <v>] [--to <v>]
aart correction add <runId> --step <id> --field <path> --observed <json> --corrected <json> --reason <text> --reviewer <name>
aart correction list [--run <runId>] [--step <id>]
aart eval create <suite> [--scorer <kind>]
aart eval add <suite> --from-run <runId>
aart eval run <suite> --workflow <workflowId> [--version <v>] [--min-score <n>]
aart request-approval <workflowId> [--version <v>] [--gate humanReview|riskReview]
aart promote <workflowId> [--version <v>]
aart deploy <workflowId> --target <target> [--version <v>]
aart trigger add <workflowId> --type <type>
aart approve <taskId> --decision <approved|rejected|needs_changes> --reviewer <name>
aart flag clear <runId> --by <name>
aart flag list
aart bundle <workflowId> [--version <v>] [--out <dir>] [--environment <name>]
aart worker [--bundle <dir>] [--store fs|sqlite] [--root <dir>]
aart server [--port <n>] [--bundle <dir>] [--environment <name>] [--store fs|sqlite] [--root <dir>]
aart mcp [--store fs|sqlite] [--root <dir>]

--root <dir>    (or AART_ROOT) the .aart store directory. Precedence: flag > env > ./.aart. Honored by every command above, not only the ones listed.
--store <kind>  fs (default) or sqlite — which @aart/store adapter backs this invocation. sqlite's db file lives at <root>/aart.db.
```

- `aart server` / `aart worker` run AART's own HTTP control plane and durable worker process — see the architecture doc's §13/§14 for local vs. production topology, or [`DEPLOY.md`](../../DEPLOY.md) for the operational version of that story.
- `aart mcp` starts AART as an MCP (Model Context Protocol) server, exposing the same tool surface the CLI wraps directly to an MCP-speaking agent.
- Local tools make an existing command reuse-first without changing its
  execution semantics or duplicating credentials. `tool register` records an
  immutable version; `find-tools` searches outcome/trigger/examples;
  `tool check` resolves versions, probes, authority, effects, and exact
  asset/executable/rendered-argv/prerequisite seals; `tool run` requires that
  complete reviewed seal set, uses fixed argv with no shell, and persists a
  redacted record for every actual spawn;
  `tool report` retrieves that record in a fresh process. Inherited
  authentication (for example the user's existing `gh` session) and
  explicit AART-secret injection are separate manifest modes.
- `aart init-agent` scaffolds the agent-facing instructions AART ships for coding assistants working against a repo that uses it, plus a ready-to-use `.mcp.json`. By default the generated config invokes this exact `aart` binary directly (`{"command": "node", "args": ["<path to this install's bin.js>", "mcp"]}`) rather than `npx` — correct regardless of exactly which install (npm or from-source) generated it, and avoids a fresh `npx` resolve on every MCP client launch. Pass `--npx` to opt into the registry-resolved `npx -y <package> mcp` form instead, safe as of `0.10.0` (see the install note above). See [`AUTHORING.md`](../../AUTHORING.md) for the full authoring-machine walkthrough.
- `aart request-approval` creates a human-approval request — for a workflow VERSION (the promotion gate) or, automatically, whenever a running workflow hits a `human.approval` step. `aart approve` records the decision either way.
- Packs distribute reusable blocks, workflows, and portable external-tool
  declarations through ordinary
  `aart-pack-<name>` npm packages plus a configured static JSON index
  (`AART_PACK_INDEX_URL`). `pack add` is intentionally inert and records the
  Pack as unapproved; the separate human `pack approve` step verifies its
  content seal and requires that exact hash through `--content-hash`, then
  inspects module shape inside a V8 isolate. Approval never
  makes Pack code trusted host code: executable Pack blocks run as synchronous
  pure JSON transforms in a fresh zero-ambient-capability isolate on every
  dispatch. Imported workflows still land as drafts and pass the normal
  workflow gates.

## Status

This is an early (`0.x`) release. The core engine, governance model, block
catalog, and public Pack prepare/search/install/approval loop are built and
tested. A Pack-backed workflow still needs destination-side Pack deployment
closure before a fresh server bundle can run it unattended; see
`AMENDMENTS.md` A72. See this package's `CHANGELOG.md` for release notes.

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) — see the `LICENSE` file at the repository root.
