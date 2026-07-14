# @team-monet/aart

## 0.10.0

### Minor Changes

- First release published to npm as `latest`. `0.1.0`–`0.9.0` under this
  same package name are a different, now-superseded CLI (internally
  `aa-runtime`) that predates this repository's architecture — not part of
  this history. This release brings this repo's rebuilt CLI to npm for the
  first time: git-style remotes + `aart push` (one-command HTTP deploy),
  unified auth middleware with a localhost-default bind and token rotation,
  agent server-awareness (`aart_remote_status`/`why`/`runs`/`run` +
  `aart_remote_approve`), and the event log + live activity-feed dashboard
  + `aart watch`. Also adds `aart --version`/`-v`, which did not exist
  before this release. Beta: `0.x`, pre-`1.0.0` — see the root
  `CHANGELOG.md` and `AMENDMENTS.md` (A56 through A68) for the full detail
  and verification record.

## 0.1.0

### Minor Changes

- Initial public release of the AART governed workflow runtime CLI.

  This release merges all eight Wave-1 build sessions (engine, server,
  blocks-core, governance, MCP tool surface, evidence/evals, registry,
  LLM pack) plus the S9 integration/hardening pass: real end-to-end
  composition root wiring, a critical redaction-mechanism fix (resolved
  secret values, not names, are now correctly scrubbed from every
  persisted record), real capability/governance/evidence wiring, two
  flagship example workflows with passing end-to-end tests (domain-specific
  naming since removed, see root `CHANGELOG.md`'s Unreleased entry and
  `AMENDMENTS.md` A70 — including a genuine process-kill-and-restart proof
  of the durable wait/resume machine), and an adversarial security pass
  over redaction and the isolated-vm sandbox boundary.
