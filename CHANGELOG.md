# Changelog

Notable changes to `@team-monet/aart`, the published CLI (`packages/cli`).
This file summarizes each release; for the full build and verification
record behind every change (every session's findings, fixes, and evidence)
see [`AMENDMENTS.md`](./AMENDMENTS.md).

## 0.10.0 — 2026-07-13

**Status: beta (pre-`1.0.0`).** The first release of this repository's
rebuilt architecture to reach npm as `latest` — `npm install -g
@team-monet/aart` and `npx @team-monet/aart` now resolve to this CLI,
closing the "install from clone" trap documented in prior versions of
`AUTHORING.md`. `1.0.0` is reserved for the production-ready release;
0.x releases may still carry breaking changes until then.

> **About the npm version numbers:** `@team-monet/aart` already had
> published versions `0.1.0`–`0.9.0` before this release — a different,
> now-superseded CLI (internally called `aa-runtime`) with an unrelated
> command surface (`aart block`, `aart pack`, `aart doctor`, ...). That
> line of history is not part of this repository; `0.10.0` is this
> repository's first npm release, version-numbered to sort after it.

### Added

- **Git-style remotes + `aart push` (D1).** `aart remote add/list/remove`,
  a token-gated deploy-ingest surface on `aart server`, and `aart
  environment register` — a one-command HTTP deploy path in place of
  manual `scp`.
- **Unified auth middleware (D2a).** Every mutating route now requires a
  deploy token (previously all but `promote` were unauthenticated); a
  localhost-default bind so a fresh `aart server` no longer listens on all
  interfaces by default; token rotation (`deployTokenNext`) for
  zero-downtime key changes.
- **Agent server-awareness (D2b + Wave 2C).** `aart_remote_status`,
  `aart_remote_why`, `aart_remote_runs`, `aart_remote_run` (MCP tools +
  CLI mirrors) let an authoring agent inspect a deployed server's state
  without shelling out; `aart_remote_approve` closes the loop, letting the
  agent decide a gate on the remote directly.
- **The event log + live activity-feed dashboard + `aart watch` (V1 +
  Wave 2).** A durable, queryable event log (`GET /events`) backs a new
  activity-feed view in the dashboard with live updates over SSE (`GET
  /api/events/stream`); `aart watch` boots server + worker + dashboard as
  supervised child processes and opens a browser — one command instead of
  three terminals.
- **`aart --version` / `-v`.** Did not exist before this release.
- **Published container images.** `ghcr.io/team-monet/aart` (multi-arch:
  `linux/amd64`, `linux/arm64`), built from this same `Dockerfile`'s
  `runtime` target and pushed on every `v*` tag — `docker pull
  ghcr.io/team-monet/aart:0.10.0` / `docker compose up` now works against a
  published image, no local `--build` required. See `DEPLOY.md`'s "Pull
  (recommended)" section.

### Fixed

- The published tarball now ships a working `aart watch` dashboard leg —
  the frontend SPA and its launcher previously weren't included in a real
  `npm install -g`, so the dashboard 404'd from anything but a monorepo
  checkout.
- `aart worker`'s `GET /health` reported a hardcoded `"0.0.0"` in every
  published build (a bundling-unsafe relative `package.json` read) — now
  reports the real `0.10.0`.

See `AMENDMENTS.md` entries A56 through A69 for the full detail and
verification evidence behind every item above.

## Legacy (`0.1.0`–`0.9.0`, npm only)

Published npm versions in this range predate this repository's current
architecture — a different, now-superseded CLI (internally called
`aa-runtime`). That history isn't part of this repository; it's noted here
only so `npm view @team-monet/aart versions` doesn't look like an
unexplained gap.
