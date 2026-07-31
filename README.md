# AART

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

**AART turns work an agent does once into reusable automation another agent
can discover instead of rebuilding.** Existing local commands can be registered
as sealed, searchable tools that preserve the user's current authentication;
a human and agent can also co-author, validate, and approve reusable blocks and
workflows. The same pinned artifact can then
run deterministically on an AART server without an agent or person in the
execution loop. Governance, redaction, durable waits, and evidence are built
into that lifecycle rather than bolted on.

> **Status: pre-`1.0.0` beta.** `npm install -g @team-monet/aart` (or `npx
> @team-monet/aart <cmd>`) installs the real CLI as of `0.10.0` — the npm
> versions `0.1.0`–`0.9.0` under this same package name are a different,
> superseded CLI, not this repository. See [`AUTHORING.md`](./AUTHORING.md)
> part (b) if `aart --version` doesn't print `0.10.0` or later, or if you'd
> rather build from source (contributors, or pinning an exact commit).

## Where to go next

- **Want your coding agent to wire itself up?** [`with-aart/`](./with-aart) — paste one line into the agent you already use; it installs and verifies AART for you. See [`AUTHORING.md`](./AUTHORING.md) part (c) for what it does under the hood.
- **Setting up a second machine to author workflows with a coding agent and ship them to a running server?** [`AUTHORING.md`](./AUTHORING.md) — including `aart remote add` + `aart push`, the one-command git-remote-style deploy (part (e)).
- **Running AART for real, outside a dev laptop?** [`DEPLOY.md`](./DEPLOY.md) — Docker/compose and bare-process paths, secrets, backup/upgrade.
- **Trying AART locally for the first time?** [`TEST-DRIVE.md`](./TEST-DRIVE.md) — install, author a workflow, watch a governed pause get approved, wire it into Claude Code.
- **Already have a reliable local CLI?** Register it with `aart tool register`,
  rediscover it with `aart find-tools`, and inspect its exact executable,
  argv, prerequisites, inherited/AART-secret authentication, effects, and
  asset/executable/argv/prerequisite seals with `aart tool check` before a
  hash-bound no-shell run. Successful spawns return a `runId`; `aart tool
  runs` recovers spawn-time records after a caller restart, and `aart tool
  report <runId>` retrieves the durable, redacted evidence. See
  [`AUTHORING.md`](./AUTHORING.md#reusing-an-existing-local-command).
- **Publishing or reusing blocks/workflows?** Packs are the distribution unit:
  `aart pack prepare` validates a local `aart-pack-*` package and generates
  its public-index entry; `aart pack search` → `aart pack add` → explicit
  human `aart pack approve` closes discovery and trust without executing
  downloaded code during installation. The separately deployable
  [`packages/catalog`](./packages/catalog) Pack Library gives people the
  category/search/detail view over the same canonical index used by CLI and
  MCP; its checked-in data is clearly marked as preview fixtures until the
  production index opens.
- **License:** [Apache License 2.0](./LICENSE).

This README is deliberately minimal — a fuller landing page is planned for
the `1.0.0` release pass.
