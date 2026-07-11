# AART

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

**AART — a governed workflow runtime for AI agents.** Author, run, and
govern multi-step workflows that mix deterministic blocks (HTTP, browser,
file, data), LLM calls, and durable human-in-the-loop waits — with
approvals, capability-based trust modes, redaction, and evidence capture
built in rather than bolted on.

> **Status: pre-`1.0.0`.** `@team-monet/aart` is claimed on npm but the
> published version there predates this repo's current architecture.
> **Install from source** — see [`AUTHORING.md`](./AUTHORING.md)'s part (b)
> for the exact commands and why `npm install -g @team-monet/aart` isn't
> safe to run yet.

## Where to go next

- **Setting up a second machine to author workflows with a coding agent and ship them to a running server?** [`AUTHORING.md`](./AUTHORING.md)
- **Running AART for real, outside a dev laptop?** [`DEPLOY.md`](./DEPLOY.md) — Docker/compose and bare-process paths, secrets, backup/upgrade.
- **Trying AART locally for the first time?** [`TEST-DRIVE.md`](./TEST-DRIVE.md) — install, author a workflow, watch a governed pause get approved, wire it into Claude Code.
- **License:** [Apache License 2.0](./LICENSE).

This README is deliberately minimal — a fuller landing page is planned for
the `1.0.0` release pass.
