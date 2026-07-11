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

Ship **just the bundle directory** — small, self-contained, every byte
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
aart server --port 8080 --bundle /path/to/incoming-bundle --root /var/lib/aart-prod --store sqlite   # add --environment, see the note below
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

**A real gotcha this session found, not documented anywhere before now:**
hydrating a bundle always creates (or reuses) one synthetic `Environment`
named literally **`"bundle"`** — never the name you passed to `aart bundle
--environment <name>` when you produced it. A bundle's own manifest doesn't
record that name at all (by design — `packages/server/src/bundle/load.ts`'s
own doc comment: `aart bundle --environment production` only selects
*which deployment's `triggerConfig`* gets embedded, not a name to restore
later). Concretely: **on a store that's never been hydrated before, `aart
server --bundle <dir> --environment production ...` fails** —
`environment "production" not found` — because hydration hasn't run yet
when that flag is checked, and once it does run it creates `"bundle"`, not
`"production"`. Either omit `--environment` entirely (simplest — correct
for the common case of one bundle, one environment in play) or pass
`--environment bundle` explicitly if you want the scoping. Don't reach for
the original deploy-time name; it isn't preserved.

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
`/webhooks/<deploymentId>` (bare-process form: `bundle:<workflowId>@<version>`
— printed by the hydration result, or `GET /deployments`) returns `{"kind":
"started", "runId": "..."}`.

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
  agent.
- **A bundle doesn't carry an environment name** (part (e)'s gotcha) —
  every hydration lands under the same synthetic `"bundle"` environment
  regardless of what you named it at `aart bundle --environment <name>`
  time. Fine for the common one-bundle-one-environment case; don't expect
  `--environment <your-original-name>` to resolve against a freshly
  hydrated store.
- **Pack-delivered blocks aren't real yet.** Only the 56 core built-ins
  (`@aart/blocks-core` + `@aart/llm`) are dispatchable on a fresh store —
  same limit `TEST-DRIVE.md`/`DEPLOY.md` already document.
- **`isolated-vm` wants Node ≥26; this repo runs on Node ≥22.** Disclosed,
  pre-existing, not addressed by this document (part (b)'s install warning).
