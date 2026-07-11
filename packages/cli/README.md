# @team-monet/aart

AART — a governed workflow runtime. `@team-monet/aart` is the CLI: a thin command surface over AART's engine, governance, and MCP tool layer. It is the one package in this monorepo published to npm (see `aart_architecture_v1.md` ADR-18); every other `@aart/*` package is internal and workspace-only.

AART lets you author, run, and govern multi-step workflows that mix deterministic blocks (HTTP, browser, file, data), LLM calls, and durable human-in-the-loop waits — with approvals, capability-based trust modes, redaction, and evidence capture built in rather than bolted on.

## Install

```sh
npm install -g @team-monet/aart
```

This installs the `aart` command.

> **Before 1.0.0 ships, don't run the command above yet.** `@team-monet/aart`
> is already a real published npm package name, but the version currently
> live on the registry is a legacy, architecturally different release (a
> `commander`-based CLI predating this repo's current command surface —
> different flags, different commands, no `aart mcp`/`aart bundle`/`aart
> deploy` as documented below). `npm install -g` — and any `npx -y
> @team-monet/aart ...` invocation, including the one a coding agent's MCP
> client might run — will silently fetch that old release instead of what's
> in this repository, with no error to signal the mismatch. Until this
> package's version genuinely reaches `1.0.0` on npm, install from this repo
> instead: see [`AUTHORING.md`](../../AUTHORING.md) at the repository root
> for the exact clone → build → pack → install sequence (verified against a
> genuine fresh clone, not just "works from an existing checkout").

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
aart validate <path>
aart validate <workflowId> --registered [--version <v>]
aart list
aart register <path>
aart init
aart init-agent [--npx] [--package <name>] [--bin-path <path>] [--cwd <dir>]
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
- `aart init-agent` scaffolds the agent-facing instructions AART ships for coding assistants working against a repo that uses it, plus a ready-to-use `.mcp.json`. By default the generated config invokes this exact `aart` binary directly (`{"command": "node", "args": ["<path to this install's bin.js>", "mcp"]}`) rather than `npx`, so it's correct regardless of whether `@team-monet/aart` is genuinely on the npm registry yet — see the install warning above. Pass `--npx` to opt back into the registry-resolved `npx -y <package> mcp` form once that's actually correct for your install. See [`AUTHORING.md`](../../AUTHORING.md) for the full authoring-machine walkthrough.
- `aart request-approval` creates a human-approval request — for a workflow VERSION (the promotion gate) or, automatically, whenever a running workflow hits a `human.approval` step. `aart approve` records the decision either way.

## Example workflows

Two full, runnable example workflows ship in this repository's `examples/` directory (not part of the published package, but useful reference material if you're browsing the source):

- `examples/redacted-legacy-b/` — a bill-processing and renewal-recommendation workflow: parse → LLM extraction → deterministic validation → human review → pricing → human approval → export → a guarded renewal-timer re-entry cycle. Demonstrates the full wait/resume durability model, including surviving a real process restart mid-run.
- `examples/redacted-legacy-a/` — a marketplace-listing review workflow: LLM classification → deterministic policy check → risk scoring → conditional human review → publish/reject → correction-to-eval feedback loop. Demonstrates conditional (`if`/`then`/`else`) branching around a human-in-the-loop gate.

Both README files alongside those examples disclose exactly which steps are real, fully-implemented AART blocks versus illustrative domain-pack stand-ins (packs are a separate, later-roadmap distribution mechanism — see the architecture doc).

## Status

This is an early (`0.x`) release. The core engine, governance model, and block catalog are built and tested; domain-specific packs (installable third-party block bundles) are not yet part of this release. See this package's `CHANGELOG.md` for release notes.

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) — see the `LICENSE` file at the repository root.
