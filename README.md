# AART

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

**AART — a governed workflow runtime for AI agents.** Author, run, and
govern multi-step workflows that mix deterministic blocks (HTTP, browser,
file, data), LLM calls, and durable human-in-the-loop waits — with
approvals, capability-based trust modes, redaction, and evidence capture
built in rather than bolted on.

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
- **License:** [Apache License 2.0](./LICENSE).

This README is deliberately minimal — a fuller landing page is planned for
the `1.0.0` release pass.
