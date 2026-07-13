# Deploying AART

Founder-facing operational guide for running AART outside a dev laptop — the
Docker/compose path (recommended) and the bare-process path (systemd-style),
store choice, secrets, backup/restore, upgrades, and an honest account of
this deploy kit's operational limits. Everything below was built and
verified against a real `docker build`/`docker run`/`docker compose up`
inside this session (AMENDMENTS.md A49) — nothing here is aspirational.

See also: [`TEST-DRIVE.md`](./TEST-DRIVE.md) for the authoring-loop walkthrough
(register → validate → run → approve → promote → deploy) this document
assumes you already know; [`AUTHORING.md`](./AUTHORING.md) if you're setting
up a SEPARATE machine to author/govern workflows with a coding agent and
ship the result here (build-from-source, `aart init-agent`/MCP wiring, then
the exact `scp`-the-bundle handoff into this document's Path A/B);
[`AMENDMENTS.md`](./AMENDMENTS.md) for the decision trail behind every
`[DECISION]` referenced here.

## Contents

- [Two deployment paths](#two-deployment-paths)
- [Path A — Docker / Compose](#path-a--docker--compose)
- [Path B — bare process (systemd-style)](#path-b--bare-process-systemd-style)
- [Store choice: fs vs sqlite](#store-choice-fs-vs-sqlite)
- [Secret management](#secret-management)
- [Deploy token](#deploy-token)
- [Network binding](#network-binding)
- [Environment registration](#environment-registration)
- [Backup & restore](#backup--restore)
- [Upgrade procedure](#upgrade-procedure)
- [Verifying a deployment](#verifying-a-deployment)
- [Ops limits — read this before you rely on it](#ops-limits--read-this-before-you-rely-on-it)
- [Platform notes](#platform-notes)

---

## Two deployment paths

Both paths run the exact same code — the bundled `@team-monet/aart` CLI
(`packages/cli`, `pnpm --filter @team-monet/aart run build:publish`). Docker
is the recommended path: it gets isolated-vm's native addon and Playwright's
Chromium build right without you thinking about it (see
[Platform notes](#platform-notes)). The bare-process path is for a host
where Docker isn't available or wanted — it needs a bit more manual care
around Node/native-addon setup.

Either way, three roles run as separate long-lived processes sharing one
store:

| Role | What it is | Default port |
|---|---|---|
| `aart server` | Control plane — webhooks, `/health`, `/runs`, `/workflows`, `/deployments`, `/waiting-runs`, `/rejected-triggers`, the scheduler ticker | 8080 |
| `aart worker` | Claims and executes runs from `job_queue`; its own `/health` | 8787 |
| `aart dashboard`-equivalent | Read/light-write operator console over the server's HTTP API | 4000 |

There is no literal `aart dashboard` CLI command — `@aart/dashboard` is a
private, workspace-only package, deliberately never bundled into the
published CLI (its own `package.json`: `"private": true`; see
[Ops limits](#ops-limits--read-this-before-you-rely-on-it)). This deploy
kit's `deploy/serve-dashboard.mjs` is the "-equivalent": a thin wrapper
around `@aart/dashboard`'s real, documented `startDashboard` API, esbuild-
bundled at build time so it starts the same way the other two roles do.

## Path A — Docker / Compose

### Build

```bash
git clone <this repo> && cd aart
docker build -t aart:latest .                            # lean — no browser automation
docker build --target runtime-browser -t aart:browser .   # + Playwright's Chromium (needed by any workflow using browser.* blocks)
```

The `Dockerfile` is a multi-stage build (`node:22-bookworm-slim`): `builder`
(full pnpm workspace install + `tsc -b` + the CLI's esbuild bundle) →
`pruned` (devDependencies stripped) → `runtime-base` → `runtime` (the
default target — last stage in the file, so a plain `docker build .` with
no `--target` lands here) / `runtime-browser` (`runtime-base` + Chromium,
explicit `--target` only, never the accidental default). A `test` target
(`docker build --target test .`) runs the full gate suite + this repo's
platform smoke tests inside the container — not shipped anywhere, purely a
verification target; see [Platform notes](#platform-notes) for what running
it produced.

**Which one do you need?** If any workflow you deploy uses a `browser.*`
block (`browser.goto`, `browser.click`, `browser.screenshot`, ...), build
`runtime-browser` and use it for BOTH `server` and `worker` (whichever
process actually dispatches the step needs Chromium — in practice, that's
the worker, but build both from the same image so you never have to reason
about which role needs which). The image is meaningfully larger with
Chromium included (~3GB vs ~1.2GB, verified) — don't build it if nothing
you run needs a real browser.

### Compose (recommended starting point)

```bash
cp .env.example .env      # fill in AART_SECRET_<NAME>=... for every webhook/API secret your deployed workflows reference
docker compose up -d --build
curl http://localhost:8080/health   # {"status":"ok"}
open http://localhost:4000          # dashboard
```

`docker-compose.yml` runs `server` + `worker` + `dashboard` against one
named volume (`aart-store`, mounted at `/data` in all three) — this is what
"sharing a store volume" means concretely: a workflow registered through
`server` is immediately visible to `worker` and to `dashboard`, because
they're reading and writing the exact same SQLite database file, not three
independent stores. Verified directly: `docker compose exec server ...
register ...` followed by `docker compose exec worker ... list` shows the
same workflow from the other container.

To point `server`/`worker` at a specific deployed `Environment` (so this
server instance only activates that environment's triggers, per
`--environment`/`AART_ENVIRONMENT`, AMENDMENTS.md A45), uncomment and set
`AART_ENVIRONMENT` in `docker-compose.yml`'s `server` service — note this is
a **server-only** flag; `worker`/`dashboard` have no equivalent scoping
option today (see [Ops limits](#ops-limits--read-this-before-you-rely-on-it)).
That named `Environment` has to actually exist on this store first — either
`aart environment register <name> --trust-mode <mode>` (D1 "remotes +
push," AMENDMENTS.md A56 — see [Deploy token](#deploy-token) below) run
against the same store/volume, or the auto-vivified one `aart deploy
<workflowId> --target <name>` creates on first use.

Swap `target: runtime` for `target: runtime-browser` on `server` and
`worker` in `docker-compose.yml` if you need Chromium (see above) — `image:
aart:latest` should then become e.g. `aart:browser` too, on both services,
consistently.

### Bare `docker run` (no compose)

Useful for a quick check or a non-compose orchestrator (Nomad, ECS, k8s —
adapt the flags, the shape is the same):

```bash
docker volume create aart-data

# --host 0.0.0.0 (D2a security hardening, breaking-change bind default,
# AMENDMENTS.md A59) — required: aart server binds loopback-only by
# default, which a container's own -p 8080:8080 published port cannot
# reach from outside without this — see "Network binding" below.
docker run -d --name aart-server \
  -v aart-data:/data -p 8080:8080 \
  --env-file .env \
  aart:latest server --port 8080 --host 0.0.0.0 --store sqlite

docker run -d --name aart-worker \
  -v aart-data:/data \
  --env-file .env \
  aart:latest worker --store sqlite

docker run -d --name aart-dashboard \
  -v aart-data:/data -p 4000:4000 \
  -e AART_SERVER_URL=http://<server-host>:8080 \
  aart:latest dashboard

# One-off CLI commands (register, validate, request-approval, approve,
# promote, deploy, trigger add, bundle, environment register, ...) against
# the same store:
docker run --rm -v aart-data:/data aart:latest register /dev/stdin --store sqlite < my-workflow.yaml
```

### Signed webhooks — verified end to end

The full governed lifecycle (register → validate → request-approval →
approve → promote → deploy → trigger add --type webhook → bundle → hydrate
into a fresh server+worker → signed webhook → run completes) was run for
real against this exact image during this session, mirroring the
methodology `TEST-DRIVE.md` part (f) already established. Correctly-signed
delivery:

```bash
curl -i -X POST http://localhost:8080/webhooks/<bindingId> \
  -H "x-aart-signature: sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)" \
  -H "Content-Type: application/json" -d "$PAYLOAD"
# -> HTTP 200 {"kind":"started","runId":"..."}
```

An incorrectly-signed delivery gets `HTTP 401 {"error":"bad_hmac"}` and a
durable record on `GET /rejected-triggers` — verified directly, both paths.
`<bindingId>` is the `Deployment.id` that owns the trigger (`aart deploy`'s
own output names it); a bundle-hydrated deployment's synthetic id is
`bundle:<workflowId>@<workflowVersion>` (`packages/server/src/bundle/
load.ts`'s own documented convention) — also verified directly.

## Path B — bare process (systemd-style)

For a host without Docker. `@team-monet/aart` is not on the public npm
registry yet (this session's own constraint: no push, no publish) — build
and pack it yourself, the same way this repo's own AMENDMENTS.md
A33/A35/A42/A46 have verified installability all along:

```bash
git clone <this repo> && cd aart
pnpm install
pnpm run build
pnpm --filter @team-monet/aart run build:publish   # produces packages/cli/dist/bin.js, self-contained
pnpm run build:dashboard-launcher                   # produces packages/cli/dist/serve-dashboard.mjs + dist/frontend (needed for `aart watch`'s dashboard leg — see below)
pnpm --filter @team-monet/aart pack                 # team-monet-aart-0.10.0.tgz

# On the target host (Node >=22, matching this repo's own package.json "engines"):
npm install -g /path/to/team-monet-aart-0.10.0.tgz
aart --help
```

**Wave 2 fix pass (AMENDMENTS.md A67 FIX 3):** `pnpm run build:dashboard-launcher` is a NEW addition to this recipe — before this fix, the published tarball carried `serve-dashboard.mjs` (if that step even ran) with no frontend assets for it to serve at all, and `aart watch`'s own dashboard leg 404'd from a real `npm install -g`. It now also copies the dashboard's built SPA (`packages/dashboard/dist/frontend`) to `packages/cli/dist/frontend` — a sibling of `serve-dashboard.mjs` — which `packages/cli`'s own `"files": ["dist"]` picks up into the tarball the same as everything else in `dist/`. Order relative to `build:publish` doesn't matter (verified directly: `build-publish.mjs`'s own dead-file sweep skips `dist/frontend` by name) — this recipe just matches the Dockerfile's own established order.

`isolated-vm` and `playwright` are real npm dependencies of the CLI
(un-bundled, by design — see [Platform notes](#platform-notes)) — a plain
`npm install` resolves and, for isolated-vm, either uses its bundled
prebuilt native binary or falls back to compiling from source (needs
`g++`/`make`/`python3` on the target host if no prebuild matches its
platform — verified: it DOES fall back to compiling from source even on a
platform isolated-vm ships a prebuild for, `linux-arm64` — see
[Platform notes](#platform-notes)'s findings; keep a C++ toolchain
installed on hosts building this way). If you need `browser.*` blocks,
also run `npx playwright install --with-deps chromium` once, as the same
user that will run the service.

Example systemd units (adjust `User`/`WorkingDirectory`/paths):

```ini
# /etc/systemd/system/aart-server.service
[Unit]
Description=AART control plane
After=network.target

[Service]
Type=simple
User=aart
Environment=AART_ROOT=/var/lib/aart
Environment=AART_TRUST_MODE=governed
# AART_HOST=0.0.0.0 (D2a security hardening, breaking-change bind default,
# AMENDMENTS.md A59) — required if worker/dashboard/any remote caller runs
# on a DIFFERENT host than this one; aart server binds loopback-only by
# default now. Omit (or set to 127.0.0.1) for a genuinely single-host
# deployment where everything runs here — see DEPLOY.md's "Network binding"
# section for the full decision table.
Environment=AART_HOST=0.0.0.0
EnvironmentFile=/etc/aart/secrets.env
ExecStart=/usr/bin/aart server --port 8080 --store sqlite
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/aart-worker.service — same shape, ExecStart=/usr/bin/aart worker --store sqlite, no port
```

With the `sqlite` store, a genuinely concurrent `aart server` + `aart worker`
start on a fresh store is now coordinated and safe either order (AMENDMENTS.md
A58 — see [Store choice: fs vs sqlite](#store-choice-fs-vs-sqlite) below), so
this ordering is a startup-determinism nicety, not a correctness requirement.
Still worth doing: add `After=aart-server.service` (and, if you want systemd
to also refuse to start the worker unit at all without the server unit,
`Requires=aart-server.service`) to `aart-worker.service`'s `[Unit]` section
above, or otherwise stagger the two units' start — this makes the schema-
applying process predictable (the server applies it first in the common case)
instead of leaving it to whichever process happens to win the race.

`aart server`/`aart worker` already handle `SIGTERM`/`SIGINT` cleanly
(graceful shutdown, drains in-flight steps to their next checkpoint before
exiting — architecture §4.7; verified directly against a real signal in
prior sessions, AMENDMENTS.md A42) — systemd's default `TERM` on stop does
the right thing with no extra `KillSignal=` config needed.

For the dashboard-equivalent without Docker: as of AMENDMENTS.md A67 FIX 3,
`serve-dashboard.mjs` and its frontend ship INSIDE the installed
`@team-monet/aart` package itself (this section's own install recipe, above,
now runs `pnpm run build:dashboard-launcher` before packing) — you do NOT
need to keep the monorepo checkout around on the target host just to run the
dashboard, correcting an earlier implication here that you did. Run it
directly from wherever `npm install -g` put it:

```bash
node "$(dirname "$(readlink -f "$(command -v aart)")")/serve-dashboard.mjs"
```

(`readlink -f` resolves `aart`'s own bin-shim symlink to the real installed
`bin.js`, the same realpath resolution `aart watch`'s own `resolveRealCliEntryPath`
does internally — `serve-dashboard.mjs` is always a sibling of that real file.)
Set `AART_SERVER_URL`/`AART_STORE`/`AART_ROOT`/`AART_DASHBOARD_PORT`/
`AART_WORKER_URLS`/`AART_DEPLOY_TOKEN` as needed (`deploy/serve-dashboard.mjs`'s
own header comment documents each one) — this is the right shape when
`aart server`/`aart worker` are already running as their own independently-
supervised systemd units (this section's own topology) and you just want the
dashboard as a third, equally independent unit.

**`aart watch`** (AMENDMENTS.md A64, fix-passed by A67) is the other option
— ONE command boots server + worker + dashboard together as supervised
child processes and opens the dashboard in a browser, also now working from
this exact same global install (`aart watch --store sqlite`). It's the
right shape for local/dev use (an authoring machine, see AUTHORING.md), not
for this section's own "three independently-supervised systemd units"
production topology — `aart watch` owns its three children as a single
process tree, which doesn't compose with each role already being its own
separately-managed systemd unit.

## Store choice: fs vs sqlite

| | `fs` (default) | `sqlite` |
|---|---|---|
| Format | One JSON file per record, directory-per-collection (`architecture §5.2`) | One file, WAL mode (`architecture §5.1`) |
| Safe with >1 process writing? | **No** — no cross-process locking; concurrent writers can race | **Yes** — including a coordinated concurrent first startup (AMENDMENTS.md A58, see below) |
| Use for | A single local `aart run`/authoring session | Any deployment running `server`+`worker` (or multiple workers) against the same store — which is every real deployment |

**What "safe" means here, precisely (AMENDMENTS.md A58 — corrects this
section's own prior, unqualified "Yes"):** `sqlite` is safe for the
`server`+`worker`(+more workers) topology this deploy kit ships, INCLUDING
the case that actually crashed before this fix — two processes racing to
be the first to open and migrate a brand-new, empty store (e.g. `docker
compose up` starting `server` and `worker` at the same moment against a
fresh volume). That concurrent-startup race is now coordinated
(`PRAGMA busy_timeout` set first on every connection, plus an exclusive
`BEGIN IMMEDIATE` transaction around migration application —
`packages/store/src/adapters/sqlite/index.ts`'s `runMigrationsCoordinated`)
so neither process crashes or corrupts the schema. Beyond startup, `sqlite`
is still single-writer-at-a-time at the SQLite level, same as any WAL-mode
database (WAL: concurrent READERS, one writer at a time — concurrent writes
serialize through the file lock, they don't fail or need to be avoided).
`job_queue`'s own claim leasing (architecture ADR-05 — a conditional
`UPDATE ... WHERE claimed_by IS NULL OR lease_expires_at <= ?`) is already
built around exactly this constraint: multiple workers correctly contend
for the same row without corrupting it; they just don't write in true
parallel, which is what the leasing design already assumes.

**Always pass `--store sqlite` for `server`/`worker`/`dashboard` in
production.** `fs` is the CLI's own default (`aart run` with no flags — the
authoring-loop convenience), not a production-safe choice the moment more
than one process touches the same store root — this deploy kit's
Dockerfile/compose/systemd examples above all specify it explicitly, don't
rely on the default.

Every real deployment example in this document already uses `--store
sqlite` for exactly this reason.

## Secret management

Two mechanisms, checked in this order (`packages/cli/src/secrets.ts`,
AMENDMENTS.md A45's `createRealSecretResolver` — the one actually wired into
`aart server`'s webhook HMAC verification and any workflow step that
resolves `secrets.<NAME>`):

1. **`AART_SECRET_<NAME>` environment variable** — checked first. The
   Docker/compose examples above use this (`.env` → `env_file:`). Fastest
   path for a live deployment or CI; nothing on disk.
2. **`<root>/secrets.json`** — a flat `{"<NAME>": "value"}` JSON map,
   fallback when the env var isn't set. Persists across restarts without
   re-exporting anything each time.

Both accept a reference written as either `secrets.<NAME>` (a workflow's
`with:` block, or `--webhook-hmac-secret-ref`) or a bare `<NAME>` — both
normalize to the same lookup.

**Honest limits, stated plainly (not glossed over):** `secrets.json` has no
encryption and no access control beyond the filesystem's own — appropriate
for local/dev secret material, explicitly documented as such in the source
(`secrets.ts`'s own doc comment), not a production secret-management story.
Neither mechanism has rotation, an audit trail beyond "look at git blame /
file mtime," or integration with a real secret manager (Vault, AWS
Secrets Manager, ...). `Environment.secretSource` (a per-environment "where
does this environment's secret come from" descriptor field) exists in the
store schema and is settable, but **nothing resolves a value from it today**
— it's real, persisted, and shown read-only in the dashboard's production
view, but not wired to any actual fetch. If redacted-legacy-a needs real secret-
manager integration, that's separate feature work, not something to expect
from `AART_SECRET_*`/`secrets.json` as shipped.

For a real deployment: prefer `AART_SECRET_*` env vars injected by whatever
already manages secrets for your infrastructure (systemd's
`EnvironmentFile=`, your container orchestrator's secret-injection
mechanism, ...) over `secrets.json` — one less plaintext file on disk.

## Deploy token

D1 "remotes + push" (AMENDMENTS.md A56) added a REMOTE deploy surface —
`aart push`/the MCP `aart_deploy` tool bundle a workflow version and POST
it straight to a running `aart server` over HTTP, instead of `scp`-ing a
bundle by hand (see `AUTHORING.md`'s "(e) Deploying to the server"). A
SEPARATE bearer token, distinct from the webhook secrets above, gates this.

### Gating matrix

**Read this before fronting `aart server` with a reverse proxy (D1 fix-pass
ruling, AMENDMENTS.md A57; scope widened to nearly every write route by D2a
security hardening, AMENDMENTS.md A59; extended to two READ routes by D2b
"remote reads," AMENDMENTS.md, this session; widened to a third by the
D2b/V1 fix pass, AMENDMENTS.md A63 FIX 1).** Not every route behaves the
same way; know which tier a route you care about is in:

| Tier | Routes | `AART_DEPLOY_TOKEN` unset | `AART_DEPLOY_TOKEN` set |
| --- | --- | --- | --- |
| **Fail-closed** | `POST /bundles/ingest`, `POST /bundles/plan`, `POST /environments` | Refuses **every** request, `401`, naming the env var as the remedy — no "auth disabled" state at all. | Requires a valid `Authorization: Bearer <token>` (or, mid-[rotation](#deploy-token), `AART_DEPLOY_TOKEN_NEXT`); wrong/missing -> `401`. |
| **Conditionally gated** | Every OTHER write route: `POST /workflows/:id/promote`, `/approve`, `/block-promotion`, `/unblock-promotion`, `/mark-needs-review`, `/clear-needs-review`, `/trigger-improvement`; `POST /runs/trigger`, `/runs/:runId/resume`, `/runs/:runId/signal`, `/runs/:runId/flag/clear`; `POST /approvals/:id/decision`; `POST /corrections`, `/corrections/:key/update-run-output`, `/corrections/:key/create-eval-example`, `/corrections/:key/create-issue`; `POST /evals/suites`, `/evals/runs` — **plus three READS** (`GET /runs`/`GET /runs/:id`, D2b, AMENDMENTS.md this session; `GET /flagged-runs`, added by the D2b/V1 fix pass, AMENDMENTS.md A63 FIX 1). See the note directly below this table for why three GETs sit in a tier every other member of is otherwise a write — and why `GET /waiting-runs`, right next to `/flagged-runs`, is NOT one of them. | **Open** — unchanged pre-A56 (writes)/pre-D2b (the three reads) behavior on every one of these, so a tokenless local/dev/TEST-DRIVE deployment keeps working with zero config change. One loud warning is logged ONCE at server startup (not per-request) when this is the case. | Requires the SAME valid Bearer (or rotation-successor token) the fail-closed tier does; wrong/missing -> `401` (a differently-worded, route-specific remedy — "provide a valid token, this route requires it to <action>" — not "set `AART_DEPLOY_TOKEN`," since one already is; all three reads' own remedy names "read run data"). |
| **Open, always** | Every OTHER GET route (`/workflows`, `/workflows/:id`, `/deployments`, `/environments`, `/approvals`, `/corrections`, `/evals`, `/waiting-runs`, `/rejected-triggers`, `/events`, `/health`); the three `/webhooks/*` routes (separate, per-binding HMAC verification — [Secret management](#secret-management) above — `AART_DEPLOY_TOKEN`/rotation plays no role here at all, untouched by this gate; these three DO carry their own, larger request-body cap, unrelated to auth — see [Ops limits](#ops-limits--read-this-before-you-rely-on-it)'s "Request body size caps" bullet, AMENDMENTS.md A60) | Unaffected either way — `AART_DEPLOY_TOKEN` plays no role here at all. | Unaffected either way. |

**Why `GET /runs`/`GET /runs/:id`/`GET /flagged-runs` specifically (D2b
"remote reads," AMENDMENTS.md, this session, John-ratified 2026-07-12's
"gate the run-read routes" fork; `GET /flagged-runs` added one fix pass
later, AMENDMENTS.md A63 FIX 1).** D2b added four new `aart_remote_*` MCP
tools (`@aart/mcp`) that let an authoring agent read a DEPLOYED server's run
history and individual run reports over the network — the same real
`GET /runs`/`GET /runs/:id` these two routes always served, just newly
reachable through an agent's tool call instead of only a human hitting the
API directly. A run's full trace/inputs/outputs can carry residual
secret-adjacent content (tool-call arguments, external-call metadata, ...),
so once that content is agent-discoverable over the network the same way
D2a's own write-gating raised the bar on "who can mutate this server,"
these reads get the identical "gated once a token is configured, open
otherwise" treatment.

**`GET /events` is open, not by omission (D2b/V1 fix pass, AMENDMENTS.md
A63 FIX 2 — previously absent from this table entirely, a genuine doc gap,
not a deliberate silence).** It exposes run-lifecycle METADATA only —
workflow id/version, status, timing, and the ids involved (`runId`,
`deploymentId`, `environmentId`, ...) — never a step's trace/inputs/
outputs (`EventLogEntrySchema`, `@aart/types`' `event-log.ts`, has no such
field). It sits in the same open-always sensitivity tier as `/deployments`/
`/approvals`, not the gated tier `GET /runs`/`GET /runs/:id`/
`GET /flagged-runs` occupy, and is the activity-feed source the dashboard
reads live.

`GET /flagged-runs` (`packages/server/src/flags.ts`'s
`listFlaggedRuns`) returns the SAME full `RunRecord[]` shape, just
pre-filtered server-side to failed+unresolved-flag runs — it was missed in
D2b's own pass and stayed open, which meant an unauthenticated caller could
still read every reclaim-exhausted/poison run's full trace through that one
route alone, regardless of the other two being gated. `GET /waiting-runs`,
registered immediately next to `/flagged-runs` in `http/server.ts`, was
evaluated for the identical gating and deliberately left OPEN instead:
`WaitStore.list()`'s own return shape (`@aart/store`) is
`{runId, stepId, wait, createdAt}[]` — `WaitCondition`'s 7-member union
(`@aart/types`' `wait.ts`) never carries trace/inputs/outputs, so there is
no secret-adjacent content on that route for this gate to protect. Every
other GET route is UNCHANGED — still always open; the gated tier stops at
these three.

**As of D2a (AMENDMENTS.md A59), "conditionally gated" is the norm, not the
exception** — before this session, only `POST /workflows/:id/promote` sat
in that tier; every other write route below it in the table above was
"open, always," identical in practice to a route with no auth concept at
all. A focused security review found that gap: any one of those routes was
just as network-reachable as promote, equally capable of mutating this
server's state, with nothing distinguishing it from a route that was NEVER
meant to need a token. They now share promote's own tier and remedy shape.

Why "conditionally gated," not fail-closed like the top tier: every route
in this tier existed and was open BEFORE `AART_DEPLOY_TOKEN` did — failing
them closed by default would have broken every existing tokenless
deployment's dashboard/CLI/MCP usage on upgrade to this session's build. The
trust-boundary reasoning for gating them AT ALL, using promote (the
original member of this tier) as the flagship example: promote is the
switch that flips a pushed-but-dormant `Deployment.promoted` from `false`
to `true` (see [Environment registration](#environment-registration) and
`AUTHORING.md`'s bundle/environment notes) — an unauthenticated promote
would let anyone who can merely REACH this server's HTTP API activate
evidence you deliberately pushed but hadn't yet promoted, which is exactly
the guarantee D1's own "push now, promote later" design depends on. The
same "anyone who can reach this API can mutate real state" reasoning
applies to triggering a run, deciding an approval, recording a correction,
and every other route in this tier. If you front this server with a
reverse proxy and only intend to protect the fail-closed tier, you are
still leaving every conditionally-gated route open unless you protect the
whole API surface, or set `AART_DEPLOY_TOKEN` and forward the
`Authorization` header through.

**Server side** — set `AART_DEPLOY_TOKEN`, checked in the exact same two
places/order as `AART_SECRET_*` above: the env var first, then
`<root>/secrets.json`'s own `"AART_DEPLOY_TOKEN"` key.

```bash
# .env (docker compose) or your process manager's own secret injection:
AART_DEPLOY_TOKEN=a-long-random-value-you-generate-yourself
```

**Client side (`aart push`/`aart_deploy`)** — `aart remote add <name> <url>
--environment <envName> --token-ref secrets.<NAME>` records only the
*reference*, never the value (same discipline as
`--webhook-hmac-secret-ref`); `aart push`/`aart_deploy` resolve it at push
time via the identical `AART_SECRET_<NAME>`-then-`secrets.json` mechanism
and send it as `Authorization: Bearer <token>`. Skip `--token-ref` and no
`Authorization` header is sent at all — fine only if the remote's own
`AART_DEPLOY_TOKEN` happens to be unset too, which (see above) means the
remote refuses the push regardless.

**Client side (the dashboard's own write actions — D1 fix pass, AMENDMENTS.md
A57; extended to every write action by D2a security hardening, AMENDMENTS.md
A59)** — a SEPARATE resolution, env-var only: set `AART_DEPLOY_TOKEN` in the
**dashboard container/process's own** environment (`docker-compose.yml`'s
`dashboard` service reads it from the same `.env` the `server`/`worker`
services do — see that file's own comments) and `@aart/dashboard`'s
`createHttpApiClient` attaches it as a Bearer header on EVERY write call it
makes (trigger a run, decide an approval, promote/approve/block a workflow
version, record a correction, create/run an eval suite, clear a run's flag,
...) — as of A57 this was promote alone (the one route the server
conditionally gated at the time); D2a widened both the server's own gating
and this client's own header attachment together, in the same session, so
they never drift out of sync. Forget this on a server where
`AART_DEPLOY_TOKEN` IS set, and every one of those actions from the
dashboard UI will `401` — the CLI's/HTTP's own equivalents still work fine
with a correct token supplied directly. See [Gating matrix](#gating-matrix)
above for the full route list this now covers.

Comparison is constant-time (`sha256` of both sides, then
`crypto.timingSafeEqual` — never a raw string compare, and never
`timingSafeEqual` on the unhashed token, which throws on a length
mismatch).

**Gating scope (D2a security hardening, AMENDMENTS.md A59).** `AART_DEPLOY_TOKEN`
now gates nearly every write route on this server, not only the three
fail-closed deploy-surface routes and promote — see [Gating
matrix](#gating-matrix) below for the current, precise table.

**Token rotation (D2a security hardening, AMENDMENTS.md A59).** Roll a
compromised or expiring token without a hard cutover: set `AART_DEPLOY_TOKEN_NEXT`
(same two resolution places as `AART_DEPLOY_TOKEN` — env var first, then
`<root>/secrets.json`'s own `"AART_DEPLOY_TOKEN_NEXT"` key) to the NEW
value. Every gated route now accepts EITHER token — update callers
(`aart remote`'s `--token-ref`, the dashboard's own `AART_DEPLOY_TOKEN`, a
reverse proxy injecting the header, ...) to the new value at your own pace,
then once every caller has switched, promote the new value to
`AART_DEPLOY_TOKEN` proper and remove `AART_DEPLOY_TOKEN_NEXT`. Leaving
`AART_DEPLOY_TOKEN_NEXT` unset (the default) changes nothing — behaves
byte-identically to before rotation existed.

```bash
# .env, mid-rotation:
AART_DEPLOY_TOKEN=the-old-token-still-valid-during-rotation
AART_DEPLOY_TOKEN_NEXT=the-new-token-callers-are-migrating-to
```

**Token-derived attribution (D2a security hardening, "mechanical half" —
named per-token identities are deferred, AMENDMENTS.md A59).** A decision
made through `POST /approvals/:id/decision` with a valid, matching deploy
token now records `ApprovalTask.authenticatedAs: "deploy-token"` alongside
the existing free-text `reviewer` field (which is untouched — still
whatever name the caller supplies, still the only identity signal for a
tokenless/local decision). `POST /workflows/:id/approve` similarly logs
(structured JSON, not persisted onto the `Workflow` record itself) which
requests were token-authenticated. This is a coarse signal today — "SOME
holder of the shared token made this decision," not "which teammate" —
since the token itself has no per-holder identity; every request
authenticated by a valid token gets the same fixed label regardless of
which of your team's callers actually sent it. Distinguishing individual
holders would need named, per-person tokens, which is real, deliberately
out-of-scope future work, not something this field claims to provide.

## Network binding

**Breaking change (D2a security hardening, AMENDMENTS.md A59, John-ratified
2026-07-12).** `aart server` now binds **loopback-only** (`127.0.0.1`) by
default — previously it bound every network interface with no flag to
control it at all. Rationale: with the [Deploy token](#deploy-token)'s
gating now covering nearly every mutation route (not just the three
fail-closed ones), the remaining honest default for a process nobody
explicitly asked to expose is "reachable only from THIS machine" — a
tokenless local/dev/TEST-DRIVE server stays fully usable from `localhost`
with zero config change, and a genuinely remote/production deployment must
now opt in explicitly.

**Set `--host 0.0.0.0` (or a specific routable IP)** to accept connections
from other hosts/containers — same flag either way, plus an `AART_HOST` env
var equivalent (flag wins over env, same precedence as `--environment`/
`AART_ENVIRONMENT`):

```bash
aart server --port 8080 --host 0.0.0.0 --store sqlite
# or
AART_HOST=0.0.0.0 aart server --port 8080 --store sqlite
```

**Who must set this on upgrade — read this before you upgrade an existing
deployment:**

- **`docker-compose.yml`'s `server` service** — already ships `--host
  0.0.0.0` in its `command:` as of this session (see that file's own
  comment on the `server` service for why this is required, not optional:
  a loopback-bound container is unreachable via the `dashboard` service's
  `AART_SERVER_URL: http://server:8080` Docker network alias AND via the
  `8080:8080` published port — and the healthcheck below it runs `curl`
  *inside* the same container's network namespace, so it would keep
  passing even without this flag, silently masking exactly that
  regression). If you maintain your own fork of this file, or a
  `docker run` invocation built from the [Bare `docker run`](#bare-docker-run-no-compose)
  section above, add `--host 0.0.0.0` to the `server` command yourself —
  every one of those examples now needs it for the identical reason
  (a container's loopback interface is not reachable through Docker's own
  port-publishing NAT, even with `-p 8080:8080` on the host side).
- **Path B / bare-process / systemd** — add `--host 0.0.0.0` (or a specific
  interface IP) to `aart-server.service`'s `ExecStart=` if `worker`/
  `dashboard`/any remote caller runs on a DIFFERENT host, or you intend to
  `aart push`/`aart_deploy` at this server remotely. A single-host
  deployment where every process (server, worker, dashboard, an operator's
  own CLI) runs on the SAME machine needs no change at all — the new
  loopback default is exactly sufficient there.
- **Any other orchestrator** (Nomad, ECS, k8s, ...) — adapt the same flag;
  the shape is identical to the Docker/compose case above (a pod/container's
  own loopback is not reachable from a sibling pod/container or the
  cluster's own service mesh without an explicit non-loopback bind).

**Not required:** a genuinely single-machine deployment (author + server +
worker + dashboard all on one host, nothing remote) needs no `--host` flag
at all — the new default is exactly what that topology already needed.

**Don't over-generalize this section — `aart worker`'s health listener is
NOT covered by any of the above.** Everything on this page is about
`aart server`'s control-plane bind. `aart worker`'s own `GET /health`
listener (default port 8787, `packages/server/src/worker/health.ts`) still
binds every interface, unchanged — deliberately, not an oversight
(AMENDMENTS.md A59 PART 3): it's read-only (`{status, claimedRuns, uptime,
version}`, zero mutation capability, categorically lower risk than the
mutation routes this whole section is about) and BY DESIGN needs to stay
cross-container-reachable (`docker-compose.yml`'s `AART_WORKER_URLS:
http://worker:8787`, feeding the dashboard's worker-health page) — locking
it to loopback would silently break that feature. If you expose a worker
on a host beyond a trusted private network/container mesh, firewall port
8787 yourself; this deploy kit does not do it for you, and `aart worker`
has no `--host` (or `--health-port`) flag today to change this bind at
all — the port is only configurable at the `WorkerConfig.healthPort`
level (`@aart/server`, not the CLI).

## Environment registration

ADR-2 (same session, AMENDMENTS.md A56): `aart environment register <name>
--trust-mode <dev|governed|strict|production>` (or the token-gated `POST
/environments` above, for the no-filesystem-access case) creates or updates
a real `Environment` record with a real trust mode — the gap this closes:
previously the only way an `Environment` came into existence was
`aart_deploy_workflow`'s own auto-vivification on first deploy, which
always creates an EMPTY config (silently defaulting to `governed`-tier
required gates, `promotion.ts`'s own `requiredGatesForEnvironment`
convention) — there was no documented way to get a real `dev`-, `strict`-,
or `production`-trust environment onto a store at all. `aart environment
list` shows every registered environment and its config. Re-registering an
existing name updates it in place (upsert), never a duplicate row.

A bundle's `--environment <name>` (`aart bundle`/`aart push`) needs the
named environment to already be registered on the DESTINATION store before
hydration — see `AUTHORING.md`'s "Environment-scoped hydration" note.

**`aart trigger add` has no `--environment` selector — stated plainly, a
known gap (a real `--environment` flag is backlog, not built here).**
`aart trigger add <workflowId> --type <type> ...`
(`packages/cli/src/commands/deployment.ts`'s `triggerAddCommand`) attaches
the trigger config to whichever of that workflow's `Deployment` rows
`store.deployments.list({ workflowId })` happens to return LAST — this is
**not** reliably "the most recently created one": the `fs` adapter's own
listing sorts alphabetically by the deployment's random `id` (unrelated to
creation time — `KeyedJsonCollection.list()`,
`packages/store/src/adapters/fs/json-file.ts`), and the `sqlite` adapter's
query has no `ORDER BY` at all (`SqliteDeploymentStore.list()`,
`packages/store/src/adapters/sqlite/stores/simple-stores.ts` — an
unspecified row order). Compounding this: every `aart deploy <id> --target
<env>` creates a BRAND NEW `Deployment` row (`deployWorkflowHandler`,
`packages/mcp/src/handlers/deployment.ts`'s `id: newId("deploy")`) — it
never updates an existing one, even for a re-deploy to the SAME
environment — so a workflow deployed more than once (to one environment
twice, or to several) accumulates multiple rows with no way for `trigger
add` to say which one it means.

**The only reliably deterministic case: a workflow's FIRST-EVER deployment,
before any other exists for it.** `aart deploy <workflowId> --target <env>`
immediately followed by `aart trigger add <workflowId> --type <type> ...`,
before deploying that workflow anywhere else — with exactly one
`Deployment` row in existence, there is nothing left to disambiguate.

**For a second (or later) deployment of the same workflow — the normal
shape once you have, say, `staging` AND `production` both — there is no
reliable way to target the new one through `trigger add` today.**
Verify which row actually changed after running it, don't assume:
`curl http://<server>:8080/deployments` (or the dashboard's Deployments/
trigger-configs view) lists every `Deployment` with its full
`triggerConfig` — the row whose `triggerConfig` now matches what you just
set (and whose `id` matches what `aart deploy`'s own JSON output printed
when you created it) is the one that actually got updated. If it picked
the wrong row, the only recourse today is re-running `trigger add` and
re-checking — the ordering is unspecified, not a toggle reliably
alternating between two rows.

## Backup & restore

**What to copy** depends on your store choice:

- **`sqlite`**: `<root>/aart.db` (plus `-wal`/`-shm` sidecar files if
  present — WAL mode, `packages/store/src/adapters/sqlite/db.ts`) and
  `<root>/secrets.json` if you're using the file-based secret fallback.
- **`fs`**: the entire `<root>` directory, recursively (`registry/`,
  `runs/`, `waits/`, `signals/`, `artifacts/`, `approvals/`,
  `standing-approvals/`, `rejected-triggers/`, `schedules/`,
  `environments/`, `deployments/`, `corrections/`, `job-queue/`,
  `schema-version.json`, `secrets.json`) — every one of these directories
  is load-bearing; there's no single "the important file."

**Consistency caveats — read before you rely on either:**

- **`sqlite`**: a live process holding the WAL open means a raw `cp` of
  `aart.db` alone can miss committed-but-not-yet-checkpointed transactions
  sitting in `-wal`. Use SQLite's own online backup instead of a raw copy
  while the store is live: `sqlite3 <root>/aart.db ".backup <dest>.db"` —
  this is safe to run against a live WAL-mode database (that's what it's
  for) and is the recommended path. A raw file copy is only guaranteed
  consistent with everything stopped first.
- **`fs`**: each individual JSON file is written atomically (temp file +
  rename — `atomicWriteFile`, `packages/store/src/adapters/fs/json-file.ts`),
  so you'll never see a half-written file. You CAN, however, capture a
  cross-file-inconsistent snapshot — e.g. a run's record present but a
  related wait/artifact file not yet written, if your backup tool walks the
  tree at exactly the wrong moment relative to an in-flight write. `fs` is
  not recommended for a live multi-process deployment anyway (see
  [Store choice](#store-choice-fs-vs-sqlite)); if you're using it for a
  single-process authoring store you want to back up, stop the process
  first, or accept that a live backup might need a `aart_get_report` sanity
  check after restore.

**Restore**: stop `server`/`worker`, replace the file(s)/directory at the
same `--root`, start them again. No separate "restore" command exists or is
needed — these processes just read whatever's at `AART_ROOT` on next start.

## Upgrade procedure

1. Build/pull the new image (or pack a new tarball, bare-process path).
2. Stop `worker` first, then `server` (draining in-flight work — graceful
   shutdown lets a worker finish its current step's checkpoint before
   exiting, architecture §4.7).
3. Start the new `server`, then the new `worker`, pointed at the SAME
   store.
4. **Store-schema migrations run automatically** on `sqlite` store open
   (`openSqliteStore`'s own `runMigrations: true` default,
   `packages/store/src/adapters/sqlite/index.ts`) — no separate `aart
   migrate` step exists or is needed today. As of this session, exactly one
   migration is registered (`0001_init`, a no-op baseline — no real schema
   change has shipped yet), so this is currently a formality, not a live
   risk; the mechanism is there for when it isn't.
5. **Engine-code schema-version compatibility is the real thing to check
   before upgrading across a version that changes it.** Distinct from the
   store-schema watermark above: every persisted `RunRecord`/`WaitCondition`
   carries its OWN `schemaVersion` tag (`packages/engine/src/
   schema-version.ts`, `CURRENT_ENGINE_SCHEMA_VERSION`, currently `1`). A
   resuming engine checks a loaded record's tag against its own compatible
   range and **fails loudly** (`SchemaVersionMismatchError`) rather than
   silently misinterpreting an old shape, if they don't match — verified in
   the source, this is an exact-match check today (`recordVersion ===
   engineVersion`), not a range. Practically: if a future AART release ships
   a `CURRENT_ENGINE_SCHEMA_VERSION` bump, any run that's currently
   `waiting` (mid-`human.approval`, mid-poll, a long renewal timer, ...) at
   upgrade time will refuse to resume under the new engine build until
   that's addressed upstream (a version-skew-tolerant release, or draining
   all `waiting` runs before upgrading across that boundary). Check the
   release notes / AMENDMENTS.md of whatever version you're upgrading to
   for whether this applies; as of this session's shipped code, no such
   bump has happened yet.
6. Verify: `GET /health` on both, run a known-good workflow through to
   completion, check `GET /rejected-triggers` didn't start accumulating
   unexpectedly.

## Verifying a deployment

```bash
curl http://<server>:8080/health    # {"status":"ok"}
curl http://<worker>:8787/health    # {"status":"ok","claimedRuns":N,"uptime":...}
curl http://<server>:8080/workflows # real registered workflows from the real store
curl http://<server>:8080/runs      # real run history -- 401s if AART_DEPLOY_TOKEN is set (D2b, Gating matrix); add -H "Authorization: Bearer <token>"
```

For a full functional smoke test, register the "no browser, no LLM" smoke
workflow from `TEST-DRIVE.md` part (b) (`data.stringify` + `assert.contains`
— needs no capabilities, so it runs to completion in `governed` mode even
as an unapproved draft, per AMENDMENTS.md A48) and run it through to
`"completed"`.

## Ops limits — read this before you rely on it

Stated plainly, matching this repo's own "What doesn't work yet" convention
(`TEST-DRIVE.md`):

- **Single-instance control plane.** `aart server` runs the scheduler
  ticker (due-timer waits, `schedule`-trigger firing, the reclaim sweep) in-
  process by default (architecture §4.4.3/§4.7's own "single-instance
  ticker" framing, `packages/server/src/config.ts`'s `runTicker` doc
  comment). **Run exactly one `aart server` instance.** `aart worker` has no
  such constraint — run as many workers as you want against the same store
  for horizontal execution capacity (`maxConcurrentRuns` per worker,
  admission-controlled). If you need `server` HA, that's real, unbuilt
  feature work (a leader-election or single-active-ticker mechanism across
  replicas), not something to fake with multiple `server` instances today.
- **No metrics/OTel EXPORTER ships today, despite the architecture
  describing one as optional.** The logging layer supports a pluggable
  `LogSink` (`packages/store/src/logger.ts`) — the LIBRARY's own default
  (`createLogger()` with no `sink` given) is still a no-op, and the type is
  shaped so a caller COULD write an OTel-bridge sink — but no
  `@opentelemetry/*` package is a dependency anywhere in this codebase
  (verified: zero matches across every `package.json`) and no such bridge is
  implemented. "Metrics via OTel" is an architectural placeholder for future
  work, not a flag you can flip today. **What you get out of the box, no
  wiring required (AMENDMENTS.md A58):** `aart server` and `aart worker`
  (both real composition roots, `packages/cli/src/real-server-port.ts`)
  unconditionally wire `consoleJsonSink` — one JSON-stringified line per log
  call, shaped `{level, msg, time, ...context}` (`service`/`component` and
  request-scoped fields like `runId` where relevant) — `debug`/`info` lines
  to stdout, `warn`/`error` lines to stderr. There is no flag to turn this
  off and no level filter — every level is always emitted; redirect/collect
  stdout+stderr with whatever your process manager or container runtime
  already does. Plus the `/health`/`/runs`/`/deployments`/
  `/rejected-triggers` HTTP endpoints for polling-based monitoring.
- **Request body size caps (AMENDMENTS.md A59/A60).** Every route on
  `aart server` has a hard cap on request body size — `Router.handle`'s own
  `readBody` (`packages/server/src/http/router.ts`) rejects an over-cap
  body `413` before JSON-parsing (or, for a gated route, before the request
  is even authenticated) ever runs, via a `Content-Length` pre-check when
  the header is present and honest, plus a running-total check during
  accumulation otherwise (catches chunked transfer-encoding, or a client
  that lies about/omits the header) — never a truly unbounded read. Three
  tiers, by route:
  1. **1MB** (`DEFAULT_MAX_BODY_BYTES`) — every control-plane route that
     doesn't specify its own cap: trigger a run, decide an approval, record
     a correction, create/run an eval suite, and similar small JSON
     payloads.
  2. **10MB** (`MAX_BUNDLE_INGEST_BYTES`) — `POST /bundles/ingest`/`POST
     /bundles/plan`, sized for a real workflow closure bundle (100% JSON
     text).
  3. **25 MiB / 26,214,400 bytes** (`MAX_WEBHOOK_INGEST_BYTES`, AMENDMENTS.md
     A60) — the three `/webhooks/*` routes, sized to (and slightly past)
     GitHub's own documented ~25MB webhook payload ceiling. These are
     EXTERNAL, operator-uncontrolled payloads, not small control-plane
     JSON — GitHub does not retry a delivery it can't make, so this bound
     has to cover the largest delivery GitHub could actually send, not a
     typical one; a body between 1MB and this cap that would have 413'd
     under tier 1 now reaches HMAC verification/intake normally.
  If you front any route with your own reverse proxy, make sure it doesn't
  impose a SMALLER cap than the tier that route actually needs.
- **No LOGIN/API-key authentication in front of the control-plane HTTP API
  or the dashboard — corrected from this bullet's own pre-D2a text, which
  overstated how open every write route was.** `GET /workflows`, most other
  GET routes, the webhook endpoints (HMAC-verified, but that authenticates
  the SENDER, not a browsing operator), and the dashboard's own pages have
  no login, API key, or per-user identity built in — there is still no
  concept of "logged-in operator" anywhere in this stack. Put a reverse
  proxy with real auth (or a private network / VPN-only exposure) in front
  of anything beyond localhost for that reason alone, regardless of the
  deploy-token gating described next.
  **`GET /runs`/`GET /runs/:id`/`GET /flagged-runs` are the GET exceptions
  (D2b "remote reads," AMENDMENTS.md this session; `GET /flagged-runs`
  added by the D2b/V1 fix pass, AMENDMENTS.md A63 FIX 1)** — see the [Gating
  matrix](#gating-matrix)'s own note for why: once `AART_DEPLOY_TOKEN` is
  configured, these three now require the same bearer token every gated
  write route does. Still not "login" or per-user identity in any real
  sense — same shared-secret, no-roles, no-per-caller-audit-trail caveat the
  rest of this bullet already states — just no longer unconditionally open
  the way every OTHER GET route still is.
  **What DID change (D2a security hardening, AMENDMENTS.md A59, breaking;
  D2b, AMENDMENTS.md this session, extended it to two run-read routes, then
  AMENDMENTS.md A63 FIX 1 to a third):** two things, together closing most
  of the actual network-reachability gap this bullet used to describe:
  1. **`aart server` binds loopback-only by default now** (previously
     every interface, with no flag to control it at all) — see [Network
     binding](#network-binding) above for the full migration note; this
     deploy kit's own compose/systemd examples already carry the required
     `--host 0.0.0.0`/`AART_HOST` override, since the topology they set up
     needs cross-process/cross-container reachability by design.
  2. **`AART_DEPLOY_TOKEN` now gates nearly every mutation route, plus
     three reads** (`GET /runs`, `GET /runs/:id`, D2b; `GET /flagged-runs`,
     AMENDMENTS.md A63 FIX 1) — not only the three
     deploy-surface routes and promote — see [Deploy
     token](#deploy-token)'s own [Gating matrix](#gating-matrix) for the
     precise, current, per-route table (fail-closed / conditionally-gated
     / open-always tiers). Unconfigured, the conditionally-gated tier
     stays fully open (unchanged pre-D2a/pre-D2b behavior, one loud startup
     warning) — a tokenless local/dev/TEST-DRIVE deployment needs zero
     config change and is no less usable than before.
  **Still true, stated plainly:** a `AART_DEPLOY_TOKEN`-configured server
  is a bearer-token-gated API, not a logged-in, per-user-authenticated one
  — anyone holding the one shared token can do anything any other holder
  can (no roles, no per-caller audit trail beyond the mechanical
  [token-derived attribution](#deploy-token) this session also added).
  Don't mistake "`AART_DEPLOY_TOKEN` is configured" for "this server has
  real authentication" — it closes the "anonymous internet caller can
  mutate my data" gap, not the "which of my three teammates did this" one.
- **The dashboard is API-complete except two narrower gaps** (`@aart/dashboard`,
  AMENDMENTS.md A47 — owned by a different session than this deploy kit,
  which packages what exists rather than changing it). Every read AND
  write route — trigger a run, approve/promote/block a workflow version,
  decide an approval task, record/act on a correction, create/run an eval
  suite, clear a run's flag — goes through the same real `@aart/server`
  HTTP API and underlying functions the CLI/MCP surfaces call, not a
  dashboard-local reimplementation (closing the store-divergence bug class
  documented in AMENDMENTS.md A43, and the `riskReview`/`humanReview`
  approval-task misattribution documented in A46 — both fixed at their
  source, no longer dashboard-specific caveats). The two still-genuine
  gaps: resuming a run's own wait step and rendering the HTML execution
  report are still local mirrors, not yet wired to the real engine/evidence
  packages — use the CLI or MCP surface for those until that wiring lands.
  Separately: this deploy kit's own `dashboard` launcher
  (`deploy/serve-dashboard.mjs`) now overrides `createStubDeps(store)`'s
  `redact` field with `@aart/governance`'s real `redactRecord` (AMENDMENTS.md
  A51 closes the gap this note used to flag) — the same bare reference
  every other real composition root in this codebase binds, with zero
  adapter needed. The dashboard's redaction chokepoint (every run-bearing
  API response routes through `deps.redact` before serialization) now has
  the real algorithm wired into THIS launcher too, not a stand-in
  documented as never-invoked-in-production.
  One nuance worth being explicit about, verified directly rather than
  assumed: `server.ts`'s own chokepoint always calls `deps.redact(run, new
  Set())` — an EMPTY resolved-secrets set, by that file's own explicit
  design (defense-in-depth over a `RunRecord` the engine already redacted
  at write time, not the primary scrub). `redactRecord` only replaces
  values it's told to look for via that second argument, so fed an empty
  set — every existing call site's own choice, unrelated to this fix — it
  returns the record unchanged, same observable output `identityRedact`
  always gave. Wiring in the real function was still the right fix (a
  production composition root has no business carrying a stub whose own
  doc comment calls it "never-invoked-in-production," and this closes the
  gap for any future caller that DOES thread a real resolved-secrets set
  through), but don't expect a value planted only in a run's trace to
  visibly disappear from `/api/runs`, `/api/runs/:id`, or `/api/artifacts`
  as a direct result of this specific change.
- **Pack-delivered blocks aren't in the real catalog yet.** Only the 56
  core built-ins (`@aart/blocks-core` + `@aart/llm`) are dispatchable on a
  fresh store with no packs installed — documented gap, not this deploy
  kit's to close.
- **Schedule-fired triggers can't be scoped to a specific target
  environment yet.** Every OTHER trigger type (webhook, github, slack,
  poll, queue, database, email, file, sdk) is sourced from
  `Deployment.triggerConfig` and carries a real `environmentId` through to
  the capability-dispatch gate (AMENDMENTS.md A48); `schedule` triggers are
  sourced from a separate `Schedule` store record with no environment field
  in its frozen shape. A schedule-fired run is gated by the hosting
  process's own ambient trust mode (`governed` by default — not an
  accidental bypass), just not by a SPECIFIC named environment the way a
  deployed webhook is. Closing this needs a store-schema change, flagged
  for a future session, not attempted here.
- **`--environment`/`AART_ENVIRONMENT` scoping exists only on `aart
  server`.** `aart worker`/the dashboard launcher have no equivalent flag —
  a worker claims and executes ANY pending run in the shared store
  regardless of which environment triggered it; scoping which triggers
  ever CREATE a run in the first place is what `server`'s `--environment`
  actually controls.
- **The dashboard has no "promoted" badge yet** (D1 "remotes + push,"
  AMENDMENTS.md A56 — a flagged, explicitly out-of-scope residual, not an
  oversight). `Deployment.promoted` (`false` = evidence recorded via a
  bundle push, awaiting a real promotion before its trigger goes live) is
  fully real in the store and API (`GET /deployments`), but
  `@aart/dashboard`'s `ProductionPage.tsx` doesn't render it — an operator
  checking deployment status there today can't visually distinguish a
  promoted, live deployment from one still awaiting promotion. Use `GET
  /deployments` directly, or `aart_deploy --plan`'s preview, until that
  frontend work lands.

## Platform notes

Everything in this section comes from actually running the from-clean gate
suite (`pnpm run clean && check:tsconfig-refs && build && typecheck &&
typecheck:tests && lint:redaction && test`) and this repo's own platform
smoke tests (`pnpm run smoke`) **inside the Docker `test` target** —
`node:22-bookworm-slim`, Debian/glibc — the first genuine Linux run of this
codebase (every prior session ran on macOS). Result: **220 test files /
2171 tests, all green**, byte-for-byte matching the macOS gate-suite count,
plus both platform smoke tests passing.

- **isolated-vm (native addon, the `node`-type block sandbox's dependency,
  `packages/engine/src/sandbox/node-sandbox.ts`) — works, with one real
  surprise.** It ships prebuilt native binaries for `linux-x64` AND
  `linux-arm64` inside the npm package itself
  (`node_modules/isolated-vm/prebuilds/`) — verified by inspection. Its own
  install script (`node-gyp-build || node-gyp rebuild`) is DESIGNED to use
  a matching prebuild without compiling anything. **Empirically, on this
  session's arm64 Linux container, it compiled from source anyway** (a full
  g++ build, ~40 seconds, visible in the Docker build log) rather than
  using the bundled `linux-arm64` prebuild — not investigated further (the
  Dockerfile includes `g++`/`make`/`python3` specifically because of this,
  so it isn't a blocker), but worth knowing: don't assume the prebuild path
  is what actually runs even when one exists for your platform. Once
  installed (compiled or prebuilt), it works correctly — verified with a
  direct isolate-create/eval/dispose check inside the running container,
  and via the full `node-sandbox.test.ts` suite (19 tests) passing,
  including the adversarial memory-limit-enforcement tests.
- **Playwright/Chromium — works, needs `--with-deps`.** `playwright
  install chromium` alone downloads the browser binary but not the OS-level
  shared libraries (glib, nss, atk, cups, ...) a minimal
  `node:22-bookworm-slim` base doesn't carry; `playwright install
  --with-deps chromium` (what `runtime-browser`'s Dockerfile stage actually
  runs) installs both in one step. Verified with a real headless launch +
  navigate + read inside the container, AND with a real `browser.goto` +
  `web.read` + `assert.contains` workflow run to `"completed"` through the
  full engine dispatch path (not just a raw Playwright smoke check).
  `pnpm install`'s own postinstall hook for `playwright` is blocked by
  default under this repo's pnpm 10 build-script-approval policy
  (`pnpm-workspace.yaml`'s `allowBuilds` only lists `isolated-vm`/`esbuild`
  — AMENDMENTS.md A15's same mechanism) — the Dockerfile's explicit `npx
  playwright install --with-deps chromium` step doesn't depend on that
  approval at all, so this is a non-issue in practice, just worth knowing
  if you ever wonder why a plain `pnpm install` doesn't also fetch
  Chromium.
- **`node:sqlite` — works, still experimental per Node's own flag.** Every
  sqlite-backed test and the live sqlite-store CLI walkthrough in this
  document's own verification ran clean; Node still prints
  `ExperimentalWarning: SQLite is an experimental feature and might change
  at any time` on first use, unchanged from the macOS behavior already
  noted in prior sessions (root AMENDMENTS.md A17) — not new, not a Linux-
  specific concern, just a standing reminder this is Node's own
  experimental-API label, not this codebase's.
- **pnpm workspace + Docker's non-hoisted `node_modules` layout — the one
  genuine integration surprise this session hit.** pnpm links each
  package's dependencies under THAT package's own `node_modules`
  (`packages/cli/node_modules/zod`, `packages/dashboard/node_modules/
  @aart/blocks-core`, ...), never hoisted to the workspace root
  (`/workspace/node_modules` has no top-level package symlinks at all,
  verified by inspection) — a script living outside any package's own
  directory (this deploy kit's `deploy/serve-dashboard.mjs`) cannot resolve
  bare `@aart/*`/third-party imports directly. Fixed by esbuild-bundling it
  (`deploy/build-dashboard-launcher.mjs`) with its output placed inside
  `packages/cli/dist/` specifically, piggybacking on that package's own
  already-correct dependency resolution — see that build script's own
  header comment for the full reasoning. Not a bug in AART itself, just a
  real thing to know if you ever add another standalone script to this
  repo that isn't itself a workspace package.
