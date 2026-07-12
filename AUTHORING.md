# Setting up an authoring machine

Founder-facing guide for a SECOND machine (macOS) whose job is: run a coding
agent (Claude Code) wired to AART over MCP, author and govern workflows
there, and ship the finished artifact to wherever `aart server`/`aart
worker` actually run (see [`DEPLOY.md`](./DEPLOY.md)). This machine never
runs the production stack itself — it doesn't need Docker, and nothing in
this document runs the `Dockerfile`.

Everything below was verified end to end this session from a genuinely
pristine state: a fresh `git clone` over `https` (no SSH keys, no access to
any other checkout of this repo, no reused `node_modules`/pnpm store) in an
empty temp directory, built, packed, installed into an isolated npm prefix
(so the install proof doesn't depend on anything already on the verifying
machine), taken through the full authoring lifecycle, and handed off to a
second, independent process pretending to be the production server —
including firing a real signed webhook at it. Where something is a
straightforward extrapolation rather than something independently
re-verified this session, that's said explicitly (see part (e)).

See also: [`TEST-DRIVE.md`](./TEST-DRIVE.md) — the deeper local walkthrough
this document's part (d) summarizes (block authoring, `{{ }}` expression
wiring, the dashboard, more MCP tool detail); [`DEPLOY.md`](./DEPLOY.md) —
the production server side of the handoff in part (e); `packages/cli/README.md`
— the published package's own reference (once this repo reaches `1.0.0`, that's
where `npm install -g @team-monet/aart` starts being correct again — part (b)
below is about right now, pre-`1.0.0`).

## Contents

- [(a) Prerequisites](#a-prerequisites)
- [(b) The npm trap — read this first](#b-the-npm-trap--read-this-first)
- [(c) Wiring the coding agent](#c-wiring-the-coding-agent)
- [(d) The authoring lifecycle](#d-the-authoring-lifecycle)
- [(e) Deploying to the server](#e-deploying-to-the-server)
  - [Debugging a deployed workflow](#debugging-a-deployed-workflow)
- [(f) Updating the authoring install](#f-updating-the-authoring-install)
- [(g) Honest limits](#g-honest-limits)

---

## (a) Prerequisites

- **git** — to clone the repo. Anything reasonably current works; nothing
  here depends on a specific git version.
- **Node ≥22** (this repo's own `package.json` `engines.node` — the CLI's
  own `packageManager`/`engines` pin lives at the repo root, checked by
  every command below). Two ways to get it, pick one:
  - **nvm** (what this repo's own reference dev machine uses):
    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # skip if nvm is already installed
    nvm install 22
    nvm use 22
    ```
  - **Homebrew**:
    ```bash
    brew install node@22
    brew link --overwrite --force node@22
    ```
  - **If you use nvm**: note that npm's global install prefix is
    **per Node version** under nvm — `npm install -g` under Node 22 puts
    `aart` somewhere `nvm use 20` (say) won't see. Part (f) below covers
    what breaks and how to recover if you ever switch versions.
- **corepack**, to get the exact `pnpm` version this repo pins (root
  `package.json`'s `"packageManager": "pnpm@10.33.2"` — check that file if
  the version below looks stale by the time you read this):
  ```bash
  corepack enable
  corepack prepare pnpm@10.33.2 --activate
  ```
  No doc in this repo mentioned corepack before this one — without it
  you'll either need a system `pnpm` that happens to match the pin exactly,
  or risk a lockfile/engine mismatch. This is the one gap in the existing
  docs that isn't specific to authoring-machine setup; it'll bite anyone
  cloning this repo for the first time.
- **Docker — NOT needed on this machine.** Docker only matters for
  `DEPLOY.md`'s Path A, on whichever machine actually runs the production
  stack. Nothing in this document touches it.

## (b) The npm trap — read this first

**Do not run `npm install -g @team-monet/aart` yet.** It's tempting —
`packages/cli/README.md`'s own Install section leads with exactly that
command, and it IS the right command once this package reaches `1.0.0` on
npm. It is **not** right today.

Here's what actually happens if you do it now (verified this session, from
a machine with nothing else pointing at this repo): `@team-monet/aart` is
already a real, claimed npm package name, currently at `0.9.0` (published
2026-06-24 — run `npm view @team-monet/aart dist-tags` yourself; this
number will keep drifting). That published release predates this repo's
current architecture — a `commander`-based CLI with a completely different
command surface. Proof, run against a build of THIS repo that was already
correctly installed and working on `PATH`:

```
$ npx -y @team-monet/aart --help
Usage: aart [options] [command]
  ...
  -w, --workspace <dir>     workspace directory (default: $AART_WORKSPACE or ~/.aart)
Commands:
  block                     manage blocks & workflows in the local .aa registry
  show [options] <id>       print a registered definition (review it before approving)
  pack                      manage workspace packs (.aa/packs — agent-authored native blocks)
  schedule                  manage OS-delegated schedules ...
  dashboard [options]       local read-only dashboard: blocks, run history, artifacts, packs
  doctor                    check Node, sandbox, and browser setup with fix hints
  ...
```

None of that (`-w/--workspace`, `aart block`, `aart pack`, `aart schedule`,
`aart dashboard`, `aart doctor`) exists in this repo. `npx` resolved the bare
package name against the **npm registry**, not against the working `aart`
binary that was sitting right there on `PATH` — installing it globally
first wouldn't have changed that; `npx <package-name>` (as opposed to `npx
<bin-name-already-on-PATH>`) always tries the registry first for a scoped
package spec like this. This is exactly the trap `aart init-agent`'s
generated MCP config used to walk a coding agent straight into (fixed this
session — part (c) below), and it's just as real if you try it by hand.

**Install from the repo instead, until this package's version genuinely
reaches `1.0.0`:**

```bash
git clone https://github.com/team-monet/aart.git
cd aart
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @team-monet/aart run build:publish
cd packages/cli
pnpm pack                              # writes team-monet-aart-0.1.0.tgz (filename tracks the version — glob *.tgz if it's moved on)
npm install -g ./team-monet-aart-0.1.0.tgz
aart --help
```

Two warnings along the way are expected and harmless, not something you
broke:

- During `pnpm install`: `WARN Failed to create bin at .../aart-governance-lint. ENOENT: no such file or directory, open '.../packages/governance/dist/redaction-lint-cli.js'` — that bin is generated by the build step you run next; it doesn't exist yet at install time.
- During the `npm install -g` step: `npm warn EBADENGINE Unsupported engine { package: 'isolated-vm@7.0.0', required: { node: '>=26.0.0' }, current: { node: 'v22.x.x', ... } }` — `isolated-vm` (the sandbox the engine's `node`-type blocks run in) declares a Node ≥26 floor this repo hasn't caught up to yet. It installs and runs fine anyway.

`aart --help` should print this repo's real usage block (`aart run
<workflowId> --input <json> ...`, `aart register`, `aart validate
--registered`, `aart deploy --target`, `aart bundle`, `aart mcp`, ...). If
you see `-w/--workspace` or `aart doctor` instead, something upstream of
this reached npm's registry — you're back in the trap.

## (c) Wiring the coding agent

**Recommended: let your coding agent do this for you.** Open the agent in
your authoring workspace and paste:

> **Set up AART for me: read https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md and follow it, checking with me at each decision point.**

That playbook — [`with-aart/bootstrap/install.md`](./with-aart/bootstrap/install.md),
[`with-aart/README.md`](./with-aart/README.md) for the pitch — has the agent
orient to its own host, wire this workspace's MCP config (`aart init-agent`,
the same mechanism described below — the playbook doesn't reimplement it),
*offer* to install AART's working instructions **globally** (once per host,
e.g. Claude Code's user-level `CLAUDE.md`) so every AART-enabled workspace
gets the verify reflex and the authoring loop without a fresh copy each
time, and then verifies the wiring for real (lists the registered tools,
calls `aart_find_blocks`) before declaring done. It's the `with-monet`-style
agent-first install, adapted to AART's per-workspace-store model — see
`with-aart/README.md` for exactly how the two differ.

**What that playbook actually runs, and what to do by hand if you'd rather
skip the agent-first flow:** in your authoring workspace (a **separate**
directory from the repo clone above — this is where workflows and their
local `.aart` store live), e.g.:

```bash
mkdir -p ~/aart-workflows
cd ~/aart-workflows
aart init-agent
```

`aart init-agent` is the mechanical writer underneath both paths — it stays
a plain, host-agnostic command; all the "which host, which global file"
reasoning above lives in `with-aart`'s playbook, not in this command itself.
It writes two files here:

- **`AGENTS.md`** — instructions for the coding agent: the verify reflex,
  the authoring loop (discover → draft → register → validate → run →
  report), `{{ }}` expression wiring, and how approval works for this
  project's trust mode. Claude Code (or any agent that reads `AGENTS.md`)
  picks this up automatically. This is the SAME text `with-aart`'s global
  install offers to also install once per host (AMENDMENTS.md A55) — one
  generator (`packages/mcp/src/init-agent.ts`), never two hand-maintained
  copies.
- **`.mcp.json`** — the real MCP server config. As of this session it reads:
  ```json
  { "mcpServers": { "aart": { "command": "node", "args": ["<absolute path to your install's bin.js>", "mcp"] } } }
  ```
  That absolute path is wherever `npm install -g` in part (b) actually put
  it on THIS machine — resolved automatically from the running `aart`
  process, so it's always correct for however you installed it, and it
  never touches the npm registry (closing the part (b) trap for the config
  a coding agent actually spawns from). Before A54, `init-agent` always
  generated `{"command": "npx", "args": ["-y", "@team-monet/aart", "mcp"]}`
  instead — exactly the trap in part (b), just automated. If you ever need
  the old registry-resolved form (correct once `1.0.0` is genuinely
  published), pass `--npx` to `init-agent`; `--package <name>` names a
  different registry package if you're pointing at a fork.

  **Merge-safe as of AMENDMENTS.md A55:** if `.mcp.json` already has other
  servers registered (e.g. a `monet` entry, if this workspace also runs
  `with-monet`), `init-agent` reads the existing file, replaces only its own
  `aart` key, and writes the rest back untouched — it no longer deletes
  siblings. A `.mcp.json` that exists but isn't valid JSON is left alone and
  reported as an error rather than silently replaced.

Open (or restart) Claude Code with `~/aart-workflows` as its working
directory / project root — it auto-detects `.mcp.json`. Once connected, you
should see **16 `aart_*` tools** (verified this session on a brand-new
project with no `Environment`/`EvalSuite` yet registered — 5 more unlock
once you have at least one of each, e.g. `aart_deploy_workflow`; see
`TEST-DRIVE.md` part (d) for the full list): `aart_find_blocks`,
`aart_get_block`, `aart_validate`, `aart_register_block`,
`aart_run_workflow`, `aart_get_report`, `aart_verify`, `aart_approve`,
`aart_request_approval`, `aart_record_correction`, `aart_list_blocks`,
`aart_get_schema`, `aart_propose_workflow`, `aart_diff_workflow`,
`aart_list_waiting_runs`, `aart_resume_run`. If your MCP client shows zero
tools or an error, check what's actually on the other end of the `command`/
`args` in `.mcp.json` before assuming AART itself is broken — a stale
absolute path (see part (f)) fails exactly this way.

## (d) The authoring lifecycle

The exact sequence this session ran end to end from the installed binary,
authoring a small real workflow (`data.stringify` + `assert.contains` — no
browser, no LLM, no network — see `TEST-DRIVE.md` part (b) for the full
authoring tutorial this skips over: block discovery, `{{ }}` wiring
gotchas, what a failure actually looks like). One line per step; each
step's parenthetical names the `governed`-mode gate (spec's five: `validate`
/ `readiness`/`evals`/`riskReview`/`humanReview` — `governed` mode, the
default, only requires the first and last) it advances, if any:

```bash
aart register greeting-workflow.yaml                                   # saves a draft version
aart validate greeting-workflow --registered                           # gate: validate — a clean check of the REGISTERED version
aart run greeting-workflow --input '{"who":"John"}'                    # gate: readiness — a real, completed run of that exact version
aart request-approval greeting-workflow                                # opens the humanReview approval task (prints a taskId)
aart approve <taskId> --decision approved --reviewer "your-name"       # gate: humanReview — governed's 2 required gates are now both met; approval flips to "approved"
aart promote greeting-workflow                                         # checks required gates are met; ok:true once they are
aart deploy greeting-workflow --target production                      # creates/uses an Environment named "production" + a Deployment
aart trigger add greeting-workflow --type webhook --webhook-hmac-secret-ref secrets.DEMO_SECRET   # wires a trigger onto that deployment
aart bundle greeting-workflow --out ./bundle --environment production  # produces the content-addressed artifact part (e) ships
```

A capability-free draft like this one (no `file.write`/`http.*`/`browser.*`
step) runs to completion under `aart run` even before approval — an empty
declared-capability set is always a subset of whatever's granted. Add a step
with real capabilities and `aart run` genuinely refuses until you either
approve it or opt into `AART_TRUST_MODE=dev` for throwaway local iteration —
see `TEST-DRIVE.md` part (b) for that exact scenario, verified there.

`aart bundle`'s output (`./bundle/manifest.json` + `definitions/` +
`triggers.json`) is the one artifact part (e) needs — nothing else you
created locally (your `.aart` store, run history) travels with it by
design.

## (e) Deploying to the server

**The one-command way (D1 "remotes + push," AMENDMENTS.md A56) — no `scp`/
`ssh` needed at all**, once the target server exposes its HTTP API and you
have a deploy token for it:

```bash
aart remote add production https://your-server:8080 --environment production --token-ref secrets.PROD_DEPLOY_TOKEN
aart push production greeting-workflow --plan     # dry-run preview first — zero writes on the remote
aart push production greeting-workflow             # bundles + POSTs it for real (POST /bundles/ingest)
```

`aart remote add` records the remote's URL/target-environment/token
reference in `<root>/remotes.json` (never the token's actual value — that's
resolved at push time the same way webhook secrets already are:
`AART_SECRET_<NAME>` env var, then `<root>/secrets.json`). `aart push`
bundles the named workflow version and ships it straight to the remote's
`POST /bundles/ingest` — the remote server must have `AART_DEPLOY_TOKEN`
configured (see `DEPLOY.md`'s "Deploy token" section) or every push is
refused `401`. The same `deployToRemoteHandler` backs the MCP `aart_deploy`
tool too — your coding agent can push directly, same wire behavior either
way.

**The target environment (`production` above) needs registering in TWO
separate places, not one — the #1 real first-push confusion this section
exists to head off (a fix-pass finding, D1, AMENDMENTS.md A57):**

1. **On YOUR OWN (local, authoring-machine) store, before you ever run
   `aart push`.** `aart push`/`aart_deploy` resolve the remote's OWN
   configured environment (the `--environment production` you gave `aart
   remote add`, NOT a flag `aart push` itself takes) against a `Deployment`
   on **your own store** — the one `triggerConfig` that bundle ships with
   is YOURS, not the remote's (`aart deploy greeting-workflow --target
   production` first, or `aart environment register production
   --trust-mode <mode>` if you just need the environment to exist with no
   deployment yet). Skip this and `aart push` refuses locally, before any
   network call, with `Environment "production" not found on THIS store` —
   naming this exact local remedy AND explicitly saying it's separate from
   the server-side step below, precisely because those two are easy to
   conflate.
2. **On the REMOTE server, before it will accept the push.** The bundle's
   own `manifest.targetEnvironment` field (what `--environment` actually
   embeds) has to resolve against a REAL, already-registered `Environment`
   ON THE REMOTE — `ssh`'d in and run `aart environment register
   production --trust-mode <mode>` directly against the remote's store, or
   (network-only, no shell) the token-gated `POST /environments` (same
   deploy token as the push itself — see `DEPLOY.md`'s "Environment
   registration" section). Skip this and the PUSH itself (not `aart remote
   add`) fails with a remedy naming this exact remote-side command.

These are genuinely two different stores, two different registrations,
enforced at two different points (`aart push` locally, before any network
call; the remote's own ingest, over the network) — registering one does
NOT register the other, and a fresh environment name typically needs both
before a first push succeeds end to end.

**The manual way — still fully supported**, for when you don't have (or
don't want) network access from the authoring machine to the target: ship
**just the bundle directory** by hand — small, self-contained, every byte
covered by its own `manifest.json`'s `bundleHash` (a tampered or corrupted
copy is refused on load, not silently accepted):

```bash
scp -r ./bundle you@your-server:/path/to/incoming-bundle
```

**Bare-process re-hydrate** (verified end to end this session, including a
real signed webhook against the result — this is the exact mechanism
`DEPLOY.md`'s Path B already documents; nothing new here, just applied to a
bundle you authored elsewhere instead of a store you built up locally):

```bash
ssh you@your-server
aart environment register production --trust-mode governed --root /var/lib/aart-prod --store sqlite   # once, if not already registered — see the note below
aart server --port 8080 --bundle /path/to/incoming-bundle --environment production --root /var/lib/aart-prod --store sqlite
aart worker --bundle /path/to/incoming-bundle --root /var/lib/aart-prod --store sqlite                # second process, same store
```

**Docker/compose** (`DEPLOY.md` Path A is the reference for the image/
compose mechanics — not re-explained here): mount wherever you `scp` bundles
to as a volume, add `--bundle /bundle` to the `server`/`worker` service
commands in `docker-compose.yml`, and `docker compose up -d --force-recreate
server worker` to pick up a new bundle (hydration runs once at process
start, so a recreate/restart is what picks up new content — leaving
`--bundle` in the command permanently is safe: re-hydrating an unchanged
bundle is a documented no-op). **Caveat, stated plainly**: the bare-process
form above was independently re-run this session against a live second
process, HMAC-signed webhook included; this compose form is the direct
extrapolation of `DEPLOY.md`'s own established Path A pattern applied to
`--bundle`, not something this session re-verified against a live compose
stack — if it doesn't behave as described, that's the gap to report.

**Environment-scoped hydration (fixed this session — previously the #1
documented gotcha here; D1 "remotes + push," AMENDMENTS.md A56):** a bundle
produced with `--environment <name>` now records that name in its own
manifest (`targetEnvironment`), and hydrating it — via `aart push`,
`aart server --bundle`, or `aart worker --bundle` — lands the resulting
`Deployment` in that REAL environment, keyed to it specifically (so the
same workflow version can be independently pushed to two different
environments without one clobbering the other). **This requires the named
environment to already be registered on the destination store** —
`aart environment register <name> --trust-mode <dev|governed|strict|production>`
(ADR-2, same session) — hydration refuses loudly, naming that exact command
as the remedy, if it isn't. Omit `--environment` at `aart bundle` time (or
hydrate a manifest produced by a pre-D1 build) and you get the OLD,
still-fully-supported fallback: that hydration lands under one synthetic
`Environment` named literally `"bundle"` — pass `--environment bundle` if
you want that scoping, never the original name you produced under (a
legacy-format bundle never recorded one).

**The webhook/secrets handshake — the most likely real confusion, stated
plainly:** `aart trigger add ... --webhook-hmac-secret-ref secrets.DEMO_SECRET`
on the AUTHORING machine records a **reference** — a name — never a secret
value; nothing in the bundle carries the actual secret. The SERVER needs
the real value, set as `AART_SECRET_DEMO_SECRET=<value>` in its own
environment (or `<root>/secrets.json` — see `DEPLOY.md`'s Secret management
section for the full mechanism and its honest limits) before it can verify
that trigger's signature. Skip this and every webhook delivery to that
binding gets `401 {"error":"bad_hmac"}`, durably logged to `GET
/rejected-triggers` — not a crash, just a permanently-rejected trigger until
the server-side env var is actually set.

Verify the handoff worked the same way `DEPLOY.md`'s own "Verifying a
deployment" section does: `GET /health` on both processes, `GET /workflows`
shows your bundle's workflow, and a correctly-signed webhook POST to
`/webhooks/<deploymentId>` — printed by the hydration result, or `GET
/deployments` (bare-process form, no `--environment`: `bundle:<workflowId>
@<version>`; a bundle carrying a real `--environment <name>`, D1 "remotes +
push": `bundle:<workflowId>@<version>:<environmentId>`, env-scoped so the
same version can be independently hydrated into more than one environment)
— returns `{"kind": "started", "runId": "..."}`.

### Debugging a deployed workflow

**D2b "remote reads" (AMENDMENTS.md, this session)** closes a real gap the
rest of this section leaves open: once you've pushed (`aart push`/
`aart_deploy`) or bare-process-deployed a workflow, YOUR coding agent has no
visibility into what actually happens when it runs on that remote server —
`aart_get_report` only ever reads YOUR OWN local `.aart` store (see part
(g)'s "Honest limits," below). Four new MCP tools (and their CLI mirrors)
close that: your agent can ask a deployed server directly, the same way you
would over `curl`, without you having to `ssh` in and read logs by hand.

```bash
aart remote-status greeting-workflow                # local-vs-remote drift: is what's live the version/gates you think it is?
aart remote-why production greeting-workflow        # what's actually live on `production`, and why (gates/approval/who-approved)
aart remote-runs production --status failed         # compact summaries of recent runs -- find the failing one first
aart remote-run production run_abc123               # that run's FULL evidence report -- the same rendering aart_get_report gives locally
```

The debug loop this unlocks, in your coding agent's own conversation
(equivalently: `aart_remote_status`/`aart_remote_why`/`aart_remote_runs`/
`aart_remote_run` — all four register once you've configured at least one
`aart remote add`, progressive disclosure — unlike `aart_deploy`, which
registers unconditionally regardless of whether a remote exists yet, these
four are pointless with nothing to read and stay hidden until one does):

1. **`aart remote-runs <remote> --status failed`** — a deployed workflow
   isn't behaving as expected; find the failing run(s) first, compact
   summaries only (not a wall of trace data).
2. **`aart remote-run <remote> <runId>`** — pull that one run's full
   evidence report and actually read what happened, the same "never claim
   it worked without reading the report" discipline `aart_get_report`
   already holds you to for local runs.
3. **Fix the workflow locally** — `aart_validate`/`aart_run_workflow`
   against your own local copy until it's right.
4. **`aart push <remote> <workflowId>`** (or `aart_deploy`) a corrected
   version, then `aart remote-why <remote> <workflowId>` to confirm what's
   now live actually reflects it — or promote it first if it isn't yet.

`aart_remote_why` is worth calling BEFORE you start debugging a "works
locally, not remotely" report too — it's entirely possible the remote is
simply running an older, different version than the one you've been
testing against locally (`aart_remote_status` catches this across every
configured remote at once; `aart_remote_why` gives the full story — live
version, gates, approval, and who approved it where tracked — for one
specific remote).

**Redaction, stated precisely, not overclaimed.** `aart_remote_run` routes
the remote-fetched run through the EXACT SAME rendering path
`aart_get_report` uses locally (`ctx.evidence.modelFacingReport`/
`markdownReport`) — the one chokepoint this codebase's real evidence
rendering goes through, inheriting the blocking `lint:redaction` CI gate.
This is a CONSISTENCY move, not a new protection layer: per
`@aart/evidence`'s own `redact.ts` doc comment, the render-time scrub is
defense-in-depth over a `RunRecord` already redacted at write time (resolved
secret VALUES are never persisted onto a run in the first place) — reading
a remote run through this tool doesn't expose anything a real deployment
wasn't already storing in its own run history.

**`aart_remote_status`/`aart_remote_why` do NOT track who pushed or
promoted a deployment** — `whoPushed`/`whoPromoted` always report `null`,
explicitly, rather than guessing. Only human/token APPROVAL decisions carry
an `authenticatedAs` (D2a security hardening, AMENDMENTS.md A59) — surfaced
by `aart_remote_why` when one exists.

## (f) Updating the authoring install

```bash
cd ~/code/aart                                  # wherever you cloned it in part (b)
git pull
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @team-monet/aart run build:publish
cd packages/cli
pnpm pack
npm install -g ./team-monet-aart-<version>.tgz   # replaces the previous global install in place
```

Then, in your authoring workspace (`~/aart-workflows` or wherever):

```bash
cd ~/aart-workflows
aart init-agent
```

**Re-running `init-agent` after every update isn't optional** — part (c)'s
fix embeds the CURRENT install's absolute path into `.mcp.json`. That's
deliberate (it fails loudly — "command not found" — rather than silently
running the wrong thing, the same tradeoff `aart server`'s own
missing-store-root check makes), but it means the config goes stale exactly
when: `npm install -g` ever lands at a new path, or — if you use nvm — you
switch Node versions (nvm's global npm prefix is per-version, so `nvm use
20` after installing under `nvm use 22` makes the old `.mcp.json`'s path
disappear even though nothing about AART itself changed). Symptom either
way: Claude Code's MCP connection to `aart` fails to start. Fix: re-run
`aart init-agent` in each authoring workspace you use.

## (g) Honest limits

Stated plainly, matching this repo's own convention (`TEST-DRIVE.md`'s
"What doesn't work yet", `DEPLOY.md`'s "Ops limits"):

- **`llm.*` blocks need a real API key.** `llm.extract`/`llm.classify`/
  `llm.judge` are wired for real (real Anthropic provider adapter, real
  schema validation, real retries) but need `ANTHROPIC_API_KEY` (or the
  workflow's own `secrets.*` reference) set wherever the block actually
  dispatches — the authoring machine if you're running locally, the server
  if a deployed workflow uses one. Neither this document nor `TEST-DRIVE.md`
  has verified one end to end — no key was available in either session.
- **There is no `aart dashboard` on the authoring machine.** `@aart/dashboard`
  is a private, workspace-only package, never bundled into the published
  CLI — it isn't part of what part (b) installs, on purpose. The dashboard
  is a SERVER-side surface: it runs against `aart server`'s HTTP API (see
  `DEPLOY.md`'s "Two deployment paths" table and `TEST-DRIVE.md` part (e)),
  not against your local authoring store. If you want to browse what you've
  authored, `aart server --port 8080` locally and hit its `/workflows`/
  `/runs` JSON endpoints, or read `aart_get_report` through your coding
  agent — **`aart_get_report` covers LOCAL runs only** (it reads your own
  `.aart` store, nothing else — corrected here, this was previously
  unqualified and read as if it covered everything you'd authored). A run
  that happened on a REMOTE server (`aart push`/`aart_deploy`, or a
  bare-process deploy, part (e)) is invisible to it — for that, D2b's
  `aart_remote_runs`/`aart_remote_run` (part (e)'s new "Debugging a deployed
  workflow" subsection) are what actually reach it.
- **A bundle carrying `--environment <name>` needs that environment
  pre-registered on the destination, or hydration refuses** (part (e), D1
  "remotes + push," AMENDMENTS.md A56 — fixed this session; previously a
  bundle's environment name was silently discarded on every hydration, not
  just unregistered ones). `aart environment register <name> --trust-mode
  <mode>` first. Omitting `--environment` entirely still works exactly as
  before — the synthetic `"bundle"` environment fallback.
- **Pack-delivered blocks aren't real yet.** Only the 56 core built-ins
  (`@aart/blocks-core` + `@aart/llm`) are dispatchable on a fresh store —
  same limit `TEST-DRIVE.md`/`DEPLOY.md` already document.
- **`isolated-vm` wants Node ≥26; this repo runs on Node ≥22.** Disclosed,
  pre-existing, not addressed by this document (part (b)'s install warning).
