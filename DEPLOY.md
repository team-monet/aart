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

docker run -d --name aart-server \
  -v aart-data:/data -p 8080:8080 \
  --env-file .env \
  aart:latest server --port 8080 --store sqlite

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
pnpm --filter @team-monet/aart pack                 # team-monet-aart-0.1.0.tgz

# On the target host (Node >=22, matching this repo's own package.json "engines"):
npm install -g /path/to/team-monet-aart-0.1.0.tgz
aart --help
```

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

`aart server`/`aart worker` already handle `SIGTERM`/`SIGINT` cleanly
(graceful shutdown, drains in-flight steps to their next checkpoint before
exiting — architecture §4.7; verified directly against a real signal in
prior sessions, AMENDMENTS.md A42) — systemd's default `TERM` on stop does
the right thing with no extra `KillSignal=` config needed.

For the dashboard-equivalent without Docker, build `deploy/serve-dashboard.mjs`
the same way the Dockerfile does (`node deploy/build-dashboard-launcher.mjs`
after `pnpm run build`) and run the resulting `packages/cli/dist/serve-
dashboard.mjs` with `node`, or just follow `TEST-DRIVE.md` part (e)'s
original hand-written `dashboard-dev.mjs` pattern — both call the exact same
`@aart/dashboard` API.

## Store choice: fs vs sqlite

| | `fs` (default) | `sqlite` |
|---|---|---|
| Format | One JSON file per record, directory-per-collection (`architecture §5.2`) | One file, WAL mode (`architecture §5.1`) |
| Safe with >1 process writing? | **No** — no cross-process locking; concurrent writers can race | **Yes** — this is what it's for |
| Use for | A single local `aart run`/authoring session | Any deployment running `server`+`worker` (or multiple workers) against the same store — which is every real deployment |

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
SEPARATE bearer token, distinct from the webhook secrets above, gates this:

- **`POST /bundles/ingest`** — ingests a pushed bundle for real.
- **`POST /bundles/plan`** — a zero-write dry-run preview of the same.
- **`POST /environments`** — registers a new `Environment` over HTTP (the
  network-only counterpart to the `aart environment register` CLI command —
  see [Environment registration](#environment-registration) below).

Every GET route, and the three `/webhooks/*` routes (which keep their own,
separate per-binding HMAC verification — [Secret management](#secret-management)
above — completely untouched), are **not** gated by this token.

**Server side** — set `AART_DEPLOY_TOKEN`, checked in the exact same two
places/order as `AART_SECRET_*` above: the env var first, then
`<root>/secrets.json`'s own `"AART_DEPLOY_TOKEN"` key. **Unconditionally
fail-closed**: with `AART_DEPLOY_TOKEN` unset, all three routes above
refuse every request — including a genuinely correct one — with `401` and
a remedy naming the env var. There is no "auth disabled, allow anything"
state for this surface, unlike the rest of this HTTP API (which, per
[Ops limits](#ops-limits--read-this-before-you-rely-on-it) below, has none
at all by default).

```bash
# .env (docker compose) or your process manager's own secret injection:
AART_DEPLOY_TOKEN=a-long-random-value-you-generate-yourself
```

**Client side** — `aart remote add <name> <url> --environment <envName>
--token-ref secrets.<NAME>` records only the *reference*, never the value
(same discipline as `--webhook-hmac-secret-ref`); `aart push`/`aart_deploy`
resolve it at push time via the identical `AART_SECRET_<NAME>`-then-
`secrets.json` mechanism and send it as `Authorization: Bearer <token>`.
Skip `--token-ref` and no `Authorization` header is sent at all — fine only
if the remote's own `AART_DEPLOY_TOKEN` happens to be unset too, which (see
above) means the remote refuses the push regardless.

Comparison is constant-time (`sha256` of both sides, then
`crypto.timingSafeEqual` — never a raw string compare, and never
`timingSafeEqual` on the unhashed token, which throws on a length
mismatch).

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
curl http://<server>:8080/runs      # real run history
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
  `LogSink` (`packages/store/src/logger.ts`) — a no-op by default, a JSON-
  to-stdout `consoleJsonSink` available, and the type is shaped so a caller
  COULD write an OTel-bridge sink — but no `@opentelemetry/*` package is a
  dependency anywhere in this codebase (verified: zero matches across every
  `package.json`) and no such bridge is implemented. "Metrics via OTel" is
  an architectural placeholder for future work, not a flag you can flip
  today. What you get out of the box: structured JSON logs to stdout (wire
  `consoleJsonSink`), and the `/health`/`/runs`/`/deployments`/
  `/rejected-triggers` HTTP endpoints for polling-based monitoring.
- **No authentication in front of MOST of the control-plane HTTP API or the
  dashboard.** `GET /runs`, `GET /workflows`, the webhook endpoints (HMAC-
  verified, but that authenticates the SENDER, not a browsing operator),
  and the dashboard's own pages have no login, API key, or network-policy
  enforcement built in. Put a reverse proxy with real auth (or a private
  network / VPN-only exposure) in front of anything beyond localhost —
  this deploy kit's compose/systemd examples above bind to all interfaces
  by default and assume you're adding that layer yourself. **The one
  exception** (D1 "remotes + push," AMENDMENTS.md A56): `POST
  /bundles/ingest`, `POST /bundles/plan`, and `POST /environments` ARE
  gated, by the [deploy token](#deploy-token) above — but that's the ONLY
  part of this API a bearer token protects; every other route (triggering a
  run, approving/promoting a workflow version, reading run history, ...)
  remains exactly as open as this bullet describes. Don't mistake
  "`AART_DEPLOY_TOKEN` is configured" for "this server is authenticated."
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
