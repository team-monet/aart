# AART — local test drive

You're testing AART on this machine (macOS, Node v22.22.2, repo at `/Users/johnlee/code/aart`). This is the founder walkthrough: install the real published artifact the way an actual user would, run a real workflow through it, watch a real governed pause get approved, wire it into Claude Code, and start the dashboard/worker/server locally.

**Ready to run this for real, somewhere other than a laptop?** See [`DEPLOY.md`](./DEPLOY.md) (AMENDMENTS.md A49) — Docker/compose and bare-process paths, store/secret/backup/upgrade guidance, and an honest ops-limits section. This document stays the local walkthrough; that one is the production story.

**Setting up a SEPARATE machine dedicated to authoring** — a coding agent wired to AART over MCP, shipping finished workflows to a server running `DEPLOY.md`'s stack? See [`AUTHORING.md`](./AUTHORING.md) instead — same install methodology as this document, plus the from-clone build path, the `npm`-registry trap in `aart init-agent`'s generated MCP config (fixed, AMENDMENTS.md A54), and the bundle→server handoff.

**Everything below is real, not simulated.** As of AMENDMENTS.md A42, the CLI's composition root builds the real engine, real governance, real evidence, and a real worker/server/bundle backend by default — `aart run` genuinely dispatches blocks, `aart validate` genuinely checks governance rules, `aart worker`/`aart server` genuinely start real processes with real health endpoints. As of A46, the full governed lifecycle genuinely completes end to end too — every one of spec §17.1's five gates (`validate`/`readiness`/`evals`/`riskReview`/`humanReview`) now has a real CLI write path, so `aart promote`/`aart deploy` genuinely succeed for a workflow taken through this guide, not just `humanReview`. Every command below was actually run, from an actually-installed tarball, in a directory with zero access to this repo's own `node_modules` — the same install methodology used to prove the CLI is installable at all (AMENDMENTS.md A33/A35). Where something doesn't work yet, that's called out explicitly in [What doesn't work yet](#what-doesnt-work-yet), not glossed over.

Read the sections in order the first time through — each one assumes the last one happened.

---

## (a) Install from the tarball

This mirrors exactly how a real `npm install @team-monet/aart` user would end up, without needing this package to actually be on the npm registry yet.

```bash
# 1. From the repo, build the real publishable artifact (tsc -b, then esbuild-bundles
#    the entire private @aart/* workspace closure into dist/bin.js + dist/index.js —
#    AMENDMENTS.md A35 — leaving genuine third-party deps like playwright external).
cd /Users/johnlee/code/aart
pnpm install                                            # only needed if you haven't already
pnpm --filter @team-monet/aart run build:publish

# 2. Pack it into a real tarball.
cd packages/cli
pnpm pack                                                # writes team-monet-aart-0.1.0.tgz

# 3. Install that tarball in a directory that has NO access to this repo's node_modules —
#    the only way to genuinely prove it's installable, not just "works from source."
mkdir -p ~/aart-test-drive
cd ~/aart-test-drive
npm init -y
npm install /Users/johnlee/code/aart/packages/cli/team-monet-aart-0.1.0.tgz
```

You'll see one warning during install — expected, pre-existing, harmless:

```
npm warn EBADENGINE Unsupported engine { package: 'isolated-vm@7.0.0', required: { node: '>=26.0.0' }, current: { node: 'v22.22.2', ... } }
```

`isolated-vm` (the sandbox `node`-type blocks run in) declares a Node ≥26 floor; this machine runs v22.22.2. It installs and runs fine anyway — this is a disclosed, not-yet-addressed floor mismatch (A35), not a new problem.

Everything from here on runs from `~/aart-test-drive`, using the binary at `./node_modules/.bin/aart` (or just `aart` if you `npm link` it, or add `./node_modules/.bin` to your `PATH`). The rest of this doc writes it as `aart` for readability.

---

## (b) The smoke workflow walk — register → validate → run → report

Save this as `smoke-data-pipeline.yaml` in `~/aart-test-drive`. It's deliberately "no browser, no LLM" — two pure blocks, so it runs instantly and needs no API keys, no network, no fixture server:

```yaml
id: smoke-data-pipeline
name: Smoke Test - Data Pipeline
version: 0.1.0
inputs:
  who:
    type: string
    required: true
steps:
  - id: greet
    uses: data.stringify
    with:
      value: "Hello, {{ inputs.who }}! -- AART smoke test"
      format: "json"
  - id: check
    uses: assert.contains
    with:
      actual: "{{ steps.greet.outputs.output }}"
      expected: "{{ inputs.who }}"
```

**A real authoring gotcha worth knowing up front** (found while writing this exact file): `{{ }}` expressions only resolve when they're the ENTIRE value of a top-level `with:` field. An expression buried inside an array or nested object (e.g. `with: { objects: [{ who: "{{ inputs.who }}" }] }`) is passed through completely unresolved — verified directly in `@aart/expr`'s `resolveExpression` (`packages/expr/src/resolver.ts`): a non-string value is returned as-is, no recursion. Keep templated values as direct top-level `with:` fields, the same way the block examples throughout `AGENTS.md` (written by `aart init-agent`, see part (d)) always do.

```bash
aart register smoke-data-pipeline.yaml
aart validate smoke-data-pipeline.yaml
aart run smoke-data-pipeline --input '{"who":"John"}'
```

Real output:

```json
{ "ok": true, "workflowId": "smoke-data-pipeline", "workflowVersion": "0.1.0", "approval": "draft", "next": "Draft registered. Next: `aart_validate`." }
{ "ok": true, "valid": true, "findings": [], "next": "Workflow is valid. Call `aart_run_workflow` to execute it, or `aart_verify` for a quick one-shot check." }
{
  "ok": true, "runId": "<uuid>", "status": "completed",
  "trace": [
    { "stepId": "greet", "block": "data.stringify", "status": "completed" },
    { "stepId": "check", "block": "assert.contains", "status": "completed" }
  ],
  "next": "Call `aart_get_report` for the full evidence report, or `aart_list_waiting_runs` if the run is waiting."
}
```

**Want proof this is real dispatch, not an echo?** Register this variant (same workflow, an assertion that can never pass) and run it:

```yaml
# smoke-data-pipeline-should-fail.yaml — same as above, but:
  - id: check
    uses: assert.contains
    with:
      actual: "{{ steps.greet.outputs.output }}"
      expected: "this-string-is-never-present"
```

```bash
aart register smoke-data-pipeline-should-fail.yaml
aart run smoke-data-pipeline-should-fail --input '{"who":"John"}'
```

```json
{
  "ok": false, "runId": "<uuid>", "status": "failed",
  "error": "assert.contains: assertion failed — expected \"\\\"Hello, John! -- AART smoke test\\\"\" to contain \"this-string-is-never-present\"",
  "trace": [
    { "stepId": "greet", "block": "data.stringify", "status": "completed" },
    { "stepId": "check", "block": "assert.contains", "status": "failed", "error": "assert.contains: assertion failed — ..." }
  ]
}
```

A stub can't produce that — it genuinely evaluated the assertion against the real, template-resolved value and genuinely failed the run.

**The report** — there's no `aart report` CLI command (checked: it's not in `aart`'s command surface). The equivalent is the `aart_get_report` MCP tool — see part (d) for wiring `aart mcp` in, then ask your agent to call it with the `runId` from above, or drive it directly per part (d)'s "one real tool call" example. It returns the full per-step trace (inputs/outputs/timings) plus a markdown rendering.

**A second real governance moment, worth trying**: register a NEW version of the same workflow (`smoke-data-pipeline`, now `0.2.0`) that also writes a file (`artifact.write`, capability `file.write`) —

```yaml
  - id: save
    uses: artifact.write
    with: { name: "greeting.json", kind: "json_output", mime: "application/json", content: "{{ steps.greet.outputs.output }}" }
```

```bash
aart register smoke-data-pipeline-v2.yaml   # same id, version: 0.2.0, the "save" step appended
aart validate smoke-data-pipeline --registered --version 0.2.0
```

`aart validate` genuinely reports a real `capability`-class finding ("Capability \"file.write\" is required... not yet approved") — real 5-class validation (schema/reference/capability/input-safety/deployment), not a rubber stamp.

**Governance semantics note (AMENDMENTS.md A48) — what actually happens if you `aart run` this draft.** An earlier session (A42) observed this exact scenario — an unapproved draft, a Medium-risk `file.write` capability — running to completion anyway under `aart run` in `governed` mode, which read as a contradiction of the validate finding above ("not yet approved" sounds like it should block, and it didn't). That was a real bug in the DI wiring between the CLI/MCP run path and the capability-dispatch chokepoint (architecture §4.6) — settled and fixed in A48. As of this session, `aart run smoke-data-pipeline --version 0.2.0 --input '{"who":"John"}'` (still draft, unapproved, no `--environment` — `aart run` has no such flag) genuinely refuses:

```json
{
  "ok": false, "status": "failed",
  "error": "Step \"save\" (block \"artifact.write\") declares capabilities [file.write] which are not a subset of this run's granted capabilities [] (architecture §4.6, ADR-09)."
}
```

This is the default (`governed` trust mode, spec §17.2's own stated local-development default) working as designed, not a new restriction to work around. Two real ways to actually run it:
- **Approve it first** — `aart request-approval smoke-data-pipeline --version 0.2.0` then `aart approve <taskId> --decision approved --reviewer you` (part (c) below walks a live-run approval; this is the workflow-VERSION-level variant, same `aart approve` command). Once that version's `approval` is `"approved"`, the SAME `aart run` completes for real.
- **Opt into `dev` mode for throwaway iteration** — `AART_TRUST_MODE=dev aart run smoke-data-pipeline --version 0.2.0 --input '{"who":"John"}'` — spec §17.2's documented "Experimental override: dev," which "runs with warning" and skips capability gating entirely, by design, for exactly this kind of local draft-iteration loop. This is opt-in, not the default — the bug this session fixed was `aart run` silently behaving as if `dev` mode were always on, with no way to turn it off.

A capability-FREE draft (no `artifact.write`, no `browser`/`http`/`command`/... step — like `smoke-data-pipeline@0.1.0` itself, part (b)'s very first example) was never affected either way: an empty declared-capabilities set is always a subset of whatever's granted, approved or not, so the ordinary develop-test-iterate loop for pure data/logic/assertion workflows was never blocked and still isn't.

---

## (c) The pause/approve walk — the governed-pause demo

This is the moment that matters most for a governed runtime: a workflow that genuinely stops and waits for a human, and genuinely continues once approved.

```yaml
# smoke-approval-gate.yaml
id: smoke-approval-gate
name: Smoke Test - Approval Gate
version: 0.1.0
steps:
  - id: gate
    uses: human.approval
    with:
      title: "Approve the smoke test"
      description: "AART's governed-pause demo: the run stops here until a human decision is recorded via aart approve."
  - id: done
    uses: data.stringify
    with: { value: "approved and continued", format: "json" }
```

```bash
aart register smoke-approval-gate.yaml
aart run smoke-approval-gate
```

```json
{
  "ok": true, "runId": "<runId>", "status": "waiting",
  "trace": [ { "stepId": "gate", "block": "human.approval", "status": "waiting" } ],
  "next": "Call `aart_get_report` for the full evidence report, or `aart_list_waiting_runs` if the run is waiting."
}
```

The run genuinely stopped. Now find the pending approval's task id — easiest with `aart server` running (part (e) starts it; do that first if you haven't):

```bash
curl -sS http://localhost:8080/waiting-runs
# {"waits":[{"runId":"<runId>","stepId":"gate","wait":{"type":"approval","taskId":"<taskId>", ...}}]}
```

(No `aart server` running yet? The exact same data is one `aart_list_waiting_runs` MCP tool call away — see part (d).)

```bash
aart approve <taskId> --decision approved --reviewer "your-name"
```

The response shows `"outcome": { "kind": "resumed", "run": { "status": "completed", "trace": [ ...two steps, both completed... ] } }` — the SAME `aart approve` command also handles a completely different kind of approval (workflow-VERSION-level promotion review, `aart_request_approval` with a `workflowId`/`workflowVersion` instead of a live run) — the run-step case above is the one `human.approval` mid-workflow pauses create automatically.

**Note the task id is a fresh random UUID each run** (`crypto.randomUUID()`, minted by the engine itself when the wait is entered) — not something you can predict in advance, which is why the `curl`/MCP discovery step above is part of the loop, not optional.

---

## (d) Wiring `aart mcp` into Claude Code

```bash
cd ~/aart-test-drive
aart init-agent
```

This writes two files:

- **`.mcp.json`** — the real config Claude Code (or any MCP client) reads:
  ```json
  { "mcpServers": { "aart": { "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"] } } }
  ```
  It's already in the right shape and the right place (`.mcp.json` in your project root) — Claude Code auto-detects it. Open (or restart) Claude Code with `~/aart-test-drive` as the working directory / project root, and it should pick up an `aart` MCP server automatically. (If your `@team-monet/aart` isn't on the real npm registry yet, swap `"command": "npx", "args": ["-y", "@team-monet/aart", "mcp"]` for `"command": "node", "args": ["/Users/johnlee/code/aart/packages/cli/dist/bin.js", "mcp"]` — points straight at this repo's own built binary.)

- **`AGENTS.md`** — instructions for whatever agent connects, in the same "motivation-leading" voice as the tool descriptions: the verify reflex, the authoring loop (discover → draft → register → validate → run → report), how `{{ }}` expression wiring works, and how approval works per trust mode.

**What tools appear.** In a brand-new project (no `Environment`, no `EvalSuite` registered yet) you'll see **16 tools** — 5 of the full 21 are gated behind real data existing (`aart_deploy_workflow`/`aart_trigger_workflow` need ≥1 `Environment`; `aart_create_eval_from_correction`/`aart_run_eval`/`aart_promote_workflow` need ≥1 `EvalSuite`) — architecture §10.1's progressive disclosure, not a bug. Verified directly: after `aart deploy <id> --target staging` (creates the Environment even if the deployment itself is refused by unmet gates — see part (b)'s governance note) and `aart eval create <suite>`, `tools/list` genuinely returns all 21:

```
aart_find_blocks, aart_get_block, aart_validate, aart_register_block, aart_run_workflow,
aart_get_report, aart_verify, aart_approve, aart_request_approval, aart_record_correction,
aart_list_blocks, aart_get_schema, aart_propose_workflow, aart_diff_workflow,
aart_create_eval_from_correction, aart_run_eval, aart_promote_workflow,
aart_deploy_workflow, aart_trigger_workflow, aart_list_waiting_runs, aart_resume_run
```

**One real tool call to try** (in Claude Code, or any MCP client, once connected): ask it to call `aart_find_blocks` with `{"query": "assert"}` — it returns real matches from the real 56-block catalog (`assert.contains`, `assert.equals`, `assert.jsonpath`, ...) with real descriptions and relevance scores, not a canned list.

`aart mcp` stops cleanly when your client disconnects (stdin close) or on `Ctrl-C`/`SIGTERM` — verified directly against the real SDK's own `Client`/`StdioClientTransport` classes, the same ones a real MCP host uses.

---

## (e) Starting the dashboard + worker + server locally

**The server** (control plane — webhooks, approvals, the `/health`/`/runs`/`/waiting-runs`/... read API, and now every dashboard write action too — see below):

```bash
cd ~/aart-test-drive
aart server --port 8080
```
Open **http://localhost:8080/health** → `{"status":"ok"}`. Try **http://localhost:8080/runs** and **http://localhost:8080/workflows** too — real data from your `.aart` store. `Ctrl-C` stops it cleanly (prints `"Server stopped."`).

AMENDMENTS.md A47: if `~/aart-test-drive/.aart` doesn't exist yet (wrong directory, typo'd `--root`/`AART_ROOT`, or you haven't run `aart register`/`aart init` there yet), this now **refuses to start** with a clear, actionable error instead of silently binding to an empty store — the exact silent-failure class root AMENDMENTS.md A43 found. Fix the path, or hydrate a fresh one with `aart server --bundle <dir>` (part (f) below).

**The worker** (claims and executes runs from `job_queue`), in a second terminal:

```bash
cd ~/aart-test-drive
aart worker
```
Open **http://localhost:8787/health** → `{"status":"ok","claimedRuns":0,"uptime":...}` (a separate port from the server's own health, by design — ADR-16). `Ctrl-C` stops it cleanly too (`"Worker stopped."`). Same missing-root refusal as `aart server` above applies here too.

**The dashboard** is a private, workspace-only package (`@aart/dashboard`, never published — it's not part of the CLI's own bundle) — you run it from this repo, not from the installed tarball. It has no bin/dev script yet, so save this as e.g. `~/aart-test-drive/dashboard-dev.mjs` and run it with plain `node` (after `pnpm run build` in the repo, so `packages/dashboard/dist` exists):

```js
// dashboard-dev.mjs — @aart/dashboard's own documented composition-root
// usage (packages/dashboard/src/index.ts's header comment), run standalone.
// AMENDMENTS.md A47: no store, no .aart path, nothing but a server URL —
// every dashboard page (read AND write) now goes through `aart server`'s
// HTTP API alone. Needs aart server already running on :8080 (started
// above). Can be run from ANY directory — there is no relative path here
// to get wrong anymore.
import { startDashboard, createHttpApiClient } from "/Users/johnlee/code/aart/packages/dashboard/dist/index.js";

const handle = await startDashboard({
  api: createHttpApiClient("http://localhost:8080"),
  workerUrls: ["http://localhost:8787"],
  port: 4000,
});
console.log(`dashboard on http://localhost:${handle.port}`);
```

```bash
node dashboard-dev.mjs
```

**AMENDMENTS.md B1: this is now a React single-page app** (a founder-authored rewrite of the previous server-rendered pages, landed this session) — `GET /`, `/runs`, `/workflows`, etc. all serve the SAME `index.html` app shell (data loads client-side afterward, over `/api/*` JSON endpoints), so `curl`ing one of these paths directly no longer shows page-specific content the way the old server-rendered pages did; open them in an actual **browser** to see the real page (client-side routing, `packages/dashboard/frontend/src/router.tsx`). To verify real data without a browser, hit the underlying JSON API directly instead — e.g. `curl http://localhost:4000/api/runs` or `curl http://localhost:4000/api/workflows/smoke-data-pipeline` — every one of those is real, same store, same server, confirmed working end to end (a live 3-service Docker Compose smoke test this session ran registered a workflow via the server's own CLI and read it straight back through this exact endpoint).

Open **http://localhost:4000/runs** in a browser — your real registered runs. **http://localhost:4000/workflows**, **http://localhost:4000/waiting-runs**, **http://localhost:4000/flagged-runs**, **http://localhost:4000/approvals**, **http://localhost:4000/corrections**, **http://localhost:4000/evals**, **http://localhost:4000/production** are all real too. Click through into a workflow (**http://localhost:4000/workflows/smoke-data-pipeline**) for its detail page — real (root AMENDMENTS.md A43; previously this 404'd). **Not yet in the new SPA**: a Blocks/Packs page — `GET /api/blocks`, `/api/blocks/:id`, `/api/packs` are still real, live JSON endpoints (`curl http://localhost:4000/api/blocks/data.stringify` — real manifest data), just with no page consuming them yet; `/blocks/...` in a browser silently falls back to the Runs page (the SPA's router has no route for it). Flagged, not this session's to build (packages/dashboard/src/capability-catalog.ts's own doc comment).

**Every writable action is real too, as of AMENDMENTS.md A47** — trigger a run, approve/deprecate/promote/block-promotion/mark-needs-review a workflow, decide an approval task (**including a `riskReview` one — a previous version of this exact decision path misattributed a `riskReview` decision to `humanReview`; that's fixed, verified with a live two-gate walk through this exact dashboard**), record a correction and act on it, create/run an eval suite, and clear a flagged run's flag. None of these depend on this script's own store configuration at all (there isn't one) — they call the SAME real functions `aart approve`/`aart promote`/`aart request-approval`/etc. call, just reached over this dashboard's own `POST /api/*` routes instead of the CLI. AMENDMENTS.md B1 also closed a real gap the JSON API rewrite opened: every run-bearing response (`/api/runs`, `/api/runs/:id`, `/api/artifacts`) now routes through the SAME redaction chokepoint the old surface's HTML always had — a secret value is never shown, on the new surface either.

**A previous version of this exact script had a footgun**: it hard-coded an absolute placeholder path (`/Users/YOU/aart-test-drive/.aart`) you had to manually edit to your own home directory. Miss that edit — easy to do on a copy-paste — and `createFsStore` silently pointed at a directory that doesn't exist; every dashboard page/action that read or wrote straight from that store handle 404'd or silently misbehaved on data that demonstrably existed, while pages already routed through `aart server`'s own HTTP API kept working fine. That's exactly the bug root AMENDMENTS.md A43 found and started fixing from a real local test drive, one route at a time; AMENDMENTS.md A47 finishes it — this script no longer constructs a store AT ALL, so this entire class of footgun (wrong path, forgotten substitution, a local store silently drifting out of sync with the server's) can no longer recur for ANY dashboard page or action, not just the ones fixed first.

Honest note on the dashboard specifically: `resumeApproval` (the run-continuation half of resuming a genuine per-run `human.approval` wait — as opposed to a workflow-version-level gate decision, which is fully real) and report rendering (the Run detail page's HTML/Markdown/JSON transform) still use `DashboardDeps`'s own local implementations rather than `@aart/engine`'s/`@aart/evidence`'s composition-root-wired real ones (`packages/dashboard/src/stub-deps.ts`'s own header comment) — a pre-existing, narrower, separately-tracked gap this session didn't touch (neither of these ever depends on this package's own store configuration, so neither was part of the store-divergence bug class this session closed). `deps`/`store` remain accepted, optional `DashboardConfig` fields for exactly this reason, and for the local (`aart dev`, single-process) topology, where a real `AartStore` is genuinely load-bearing again.

---

## (f) Deploying a workflow to a real server — the bundle-based path

Parts (b)–(e) all ran on ONE machine. This part is the actual deploy story: author/test on your laptop, ship just the finished artifact to wherever `aart server`/`aart worker` actually run. As of this session (`AMENDMENTS.md` A44), that artifact is a real, content-addressed **bundle** — `aart bundle` already produced one (part (f)/(g) below); this session built the other half: something that actually reads one back in.

**There's now a one-command shortcut for the whole `scp`+`ssh` dance below**
(D1 "remotes + push," `AMENDMENTS.md` A56): `aart remote add production
<url> --environment production --token-ref secrets.TOKEN` once, then `aart
push production smoke-data-pipeline` — bundles + ships it over HTTP in one
call, no manual copy step. Needs the target server reachable over the
network with `AART_DEPLOY_TOKEN` configured (`DEPLOY.md`'s "Deploy token"
section) and the named environment already registered there (`aart
environment register production --trust-mode governed`, ADR-2, same
session). This walkthrough keeps documenting the manual `scp`/bare-process
path below in full, since it's what you fall back to when you don't have
(or don't want) network access from your laptop to the target — same
underlying hydration mechanism either way.

**On your laptop** (or wherever you're authoring/testing):

```bash
cd ~/aart-test-drive
aart bundle smoke-data-pipeline --out ./prod-bundle
```

(`--environment <name>` also works here if you've deployed to a real `Environment` first — part (g)'s note below — and pins the bundle's `triggers.json` to that deployment's real trigger config. As of D1 "remotes + push" (`AMENDMENTS.md` A56), it ALSO records that name in the bundle's own manifest (`targetEnvironment`), so hydrating this bundle lands in that REAL environment on the destination — provided it's registered there first (`aart environment register <name> --trust-mode <mode>`); otherwise hydration refuses loudly with that exact remedy, rather than silently falling back to the synthetic environment below. Omitted, as above, it's a bare workflow-closure bundle: every definition, no live trigger — still exactly what a fresh server needs to start executing runs you kick off with `aart run`/`aart_run_workflow`.)

Copy **just the bundle directory** to wherever the server will run — it's small, self-contained, and every byte inside it is covered by its own `manifest.json`'s `bundleHash`:

```bash
scp -r ./prod-bundle you@your-server:/path/to/prod-bundle
# or: rsync -a ./prod-bundle/ you@your-server:/path/to/prod-bundle/
# or: zip/tar it and copy however you'd copy any small directory
```

**On the server:**

```bash
aart server --port 8080 --bundle /path/to/prod-bundle
aart worker --bundle /path/to/prod-bundle   # second process, same store
```

Both hydrate the bundle's workflow/pack/prompt/schema definitions — plus its `triggers.json`, sourced as the deployment's real trigger config — into their own `.aart` store **before** starting. Verified this session against two independent, isolated-`npm`-installed copies of the CLI (`AMENDMENTS.md` A44's own methodology, not simulated): a fresh server sees exactly what the bundle carries and nothing else (`GET /workflows`, `GET /deployments`); re-running `--bundle` against an already-hydrated store is a safe no-op (`"bundle": {"kind": "already_hydrated", ...}` in the command's own result); a *different* bundle produced for the same workflow@version is refused outright (`ok:false`, before the port ever binds) rather than silently overwriting whatever's already there; `aart run <id>` against the hydrated store genuinely dispatches and completes, visible on `GET /runs` from either process; both stop cleanly on `Ctrl-C`/`SIGTERM`, same as running locally.

**What doesn't move with a bundle:** run history, waits, signals, the job queue, artifacts — a bundle seeds a store's *definitions*, it doesn't replace a store (`packages/server/src/bundle/load.ts`'s own header comment). If you need to move a server's **entire** state to a new host — every past run, every artifact, a real migration rather than a fresh deploy — `rsync` the whole `.aart` directory instead:

```bash
rsync -a ~/aart-test-drive/.aart/ you@your-server:/path/to/.aart/
```

That's the everything-including-history alternative — slower, bigger, and it carries your local dev runs along with it, which a bundle deliberately does not.

**`--environment <name>` (+ `AART_ENVIRONMENT`) — scoping which deployment's triggers actually activate** (`AMENDMENTS.md` A45): unset, `aart server`/`aart worker` activate every deployment's trigger across every environment in the store — a documented dev convenience, fine for one laptop with one environment in play. Once a store holds deployments for more than one environment (a real "staging vs. production" setup), name the one this process should serve:

```bash
aart server --port 8080 --environment production
```

A webhook/github/slack/poll binding that belongs to a DIFFERENT environment's deployment 404s against this server (`unknown trigger binding`) even though the record exists in the same store — verified directly this session: two environments, two deployments of the same workflow, a server started with `--environment production` served `production`'s binding and 404'd on `staging`'s. An unregistered environment name fails loudly at startup (`environment "X" not found`) rather than silently falling back to "everything."

**Don't confuse this `--environment` with `aart bundle --environment`'s
`targetEnvironment` above (D1 "remotes + push," `AMENDMENTS.md` A56) — two
genuinely different things that happen to share a flag name.** `aart
server --environment <name>` (this section) scopes which ALREADY-HYDRATED
deployments' triggers this RUNNING PROCESS activates — a runtime filter
over whatever's already in the store. `aart bundle --environment <name>`
(above) records which environment a bundle's contents should land IN once
hydrated — a produce-time stamp baked into the bundle itself, consumed once
by `hydrateBundle`. You'll typically use the SAME name for both (produce a
bundle targeting `production`, then serve it with `--environment
production`), but they're resolved by entirely separate code paths at
entirely separate times.

**`--store fs|sqlite` — which `@aart/store` adapter backs this invocation** (`AMENDMENTS.md` A45): `fs` (the default, unchanged) is one JSON file per record — simple, human-inspectable, fine for one process at a time. `sqlite` is a real `node:sqlite`-backed adapter (WAL mode, so `aart server` and `aart worker` can safely share ONE db file as two concurrent processes/connections — architecture §5.1's stated reason to reach for it) — its own conformance suite (the same shared test suite the `fs` adapter is held to) passes clean. The db file lives at `<root>/aart.db`:

```bash
aart server --port 8080 --store sqlite --environment production
aart worker --store sqlite   # a SECOND process, same store — this is exactly the case sqlite (not fs) is for
```

Choose `sqlite` when `aart server` and `aart worker` (or more than one of either) run as separate processes against the same store; `fs` remains fine for the common single-process local/dev case this whole guide otherwise uses.

**`--root <dir>` (+ `AART_ROOT`; precedence: flag > env var > `./.aart`)** (`AMENDMENTS.md` A45): every command in this guide has been implicitly using `./.aart`, relative to wherever you ran `aart` from. `--root`/`AART_ROOT` point it anywhere:

```bash
aart server --port 8080 --root /var/lib/aart-prod
AART_ROOT=/var/lib/aart-prod aart worker
```

Honored by every command, not only `server`/`worker`/`run`/`mcp`/`init-agent` — those five are just where it matters most in practice (the store the founder's own copy-pasted script hard-codes vs. a real deploy target's own path).

**Receive a real webhook — the actual live proof, not a description of one.** Continuing with `smoke-data-pipeline` from part (b) (or any registered workflow):

```bash
# 1. Get it to a deployable state and deploy it. `governed` mode's two
#    required gates (gates.ts's REQUIRED_GATES_BY_MODE) each need their OWN
#    real write, per spec §17.1's "each gate is advanced only by its own
#    mechanism" (AMENDMENTS.md A46 — the four gate writers this closed):
aart validate smoke-data-pipeline --registered   # WRITER: a clean check of the REGISTERED version (not the file — part (b)'s own validate call) sets gates.validate = "passed"
aart request-approval smoke-data-pipeline
aart approve <taskId> --decision approved --reviewer "your-name"   # sets gates.humanReview = "passed"; governed's other gate (validate) is already satisfied above, so approval flips to "approved" right here
aart promote smoke-data-pipeline
aart deploy smoke-data-pipeline --target production
# {"ok":true,"deployment":{"id":"deploy_XXXX", ...}, "environment":{"name":"production", ...}}

# 2. Wire a webhook trigger onto that deployment.
aart trigger add smoke-data-pipeline --type webhook --webhook-hmac-secret-ref secrets.DEMO_SECRET

# 3. Start the server with the secret available — AART_SECRET_<NAME> is the
#    quick path (a store-adjacent <root>/secrets.json file also works, see
#    below).
AART_SECRET_DEMO_SECRET="a-real-secret-value" aart server --port 8080 --environment production
```

```bash
# 4. In another terminal — sign the payload with the SAME secret and POST it.
BODY='{"who":"webhook-caller"}'
SECRET="a-real-secret-value"
SIG=$(node -e "const {createHmac}=require('node:crypto'); process.stdout.write('sha256='+createHmac('sha256','$SECRET').update('$BODY').digest('hex'))")
curl -i -X POST "http://localhost:8080/webhooks/deploy_XXXX" -H "x-aart-signature: $SIG" -d "$BODY"
# HTTP/1.1 200 OK
# {"kind":"started","runId":"<uuid>"}

# 5. A bad signature is rejected, not silently ignored — and the rejection is durable.
curl -i -X POST "http://localhost:8080/webhooks/deploy_XXXX" -H "x-aart-signature: sha256=00...00" -d "$BODY"
# HTTP/1.1 401 Unauthorized
# {"error":"bad_hmac"}
curl http://localhost:8080/rejected-triggers
# {"rejected":[{"id":"rej_...","triggerType":"webhook","reason":"bad_hmac", ...}]}
```

Both verified live this session, against the installed tarball, exactly as above (`AMENDMENTS.md` A45's own transcript). `AART_SECRET_<NAME>` (env var, checked first) or `<root>/secrets.json` (`{"<NAME>": "value"}`, checked if the env var is unset) is the real secret-resolution mechanism now wired all the way through — `secrets.<NAME>` and a bare `<NAME>` both work as the `--webhook-hmac-secret-ref` value. `github`/`slack` bindings resolve their secret the same way (`x-hub-signature-256`/`x-slack-signature` respectively) — this walkthrough uses the generic `webhook` type only because it needs no provider-specific payload shape to demonstrate.

**The CLI-only-lifecycle gap this walkthrough's own step 1 used to work around — closed, `AMENDMENTS.md` A46.** Through `AMENDMENTS.md` A45, only `humanReview` had a real write path anywhere in the CLI/MCP surface; `aart promote`/`aart deploy` refused every workflow under every non-`dev` trust mode, since `validate` (required by every mode `dev` doesn't gate) could never be satisfied for real. A46 wired the three still-missing writers, each through its own dedicated mechanism (spec §17.1: "each gate is advanced only by its own mechanism") — no shortcuts, no gate settled by the wrong evidence:

- **`validate`** — `aart validate <workflowId> --registered [--version <v>]` (step 1 above): a CLEAN check (zero error-class findings; warnings don't block) of the REGISTERED version sets `gates.validate = "passed"`; a check that finds an error sets `"failed"`. A file-path `aart validate <path>` (no `--registered`) still never touches gates — validating a draft is pre-registration, and `validate` is a fact about a stored version.
- **`readiness`** — a genuinely-completed, non-dry-run real run of that EXACT registered version (`aart run` / `aart_run_workflow`, and `aart_verify` indirectly, since it runs through the same handler) sets `gates.readiness = "passed"`. Part (b)'s own `aart run smoke-data-pipeline` already does this as a side effect once you re-walk this guide.
- **`evals`** — `aart eval run <suite> --workflow <workflowId> [--min-score <n>]`: supplying `--min-score` reuses `@aart/evidence`'s own promotion-gate threshold comparison (the identical logic `EvalRun.score >= minScore`) to set `gates.evals` to `"passed"`/`"failed"`. Omitted, an eval run stays purely informational, exactly as before.
- **`riskReview`** — the SAME `aart request-approval`/`aart approve` machinery above, with `--gate riskReview` (default remains `humanReview`): `aart request-approval <workflowId> --gate riskReview` then `aart approve <taskId> --decision approved --reviewer <name>` sets `gates.riskReview` specifically, independent of `humanReview`. No new mechanism — the approval-task machinery is the human-gate machinery for both.

Verified live, from the installed binary, in `governed` mode: register → validate --registered (`gates.validate: "passed"`) → run (`gates.readiness: "passed"`) → request-approval → approve (`gates.humanReview: "passed"`, `approval` flips to `"approved"` right there since `governed` only requires those two) → **`aart promote` → `ok:true`** → **`aart deploy` → `ok:true`** → bundle → a second, independently-installed server process hydrates it → a correctly-signed webhook starts a run that completes for real, a badly-signed one is rejected (`401 bad_hmac`) and durably recorded. The same workflow, taken all the way through `--gate riskReview` and `eval run --min-score`, also satisfies `production` mode's full 5-gate requirement (`REQUIRED_GATES_BY_MODE.production`) — not just `governed`'s two. Full transcript: `AMENDMENTS.md` A46.

---

## (g) What to try next

The real payoff of the MCP wiring in part (d) is having your coding agent **author** a workflow, not just run one you hand-wrote. With `aart mcp` connected in Claude Code:

> "Use the aart tools to find a block that checks an HTTP endpoint, draft a workflow that hits `https://example.com` and asserts the response contains 'Example', register it, validate it, run it, and show me the report."

That's the exact loop `AGENTS.md` (part (d)) describes: `aart_find_blocks` → draft with `uses`/`with` → `aart_register_block` → `aart_validate` (fix any findings) → `aart_run_workflow` → `aart_get_report`. Every tool result's own `next` field tells the agent what to do next, so it doesn't need to re-derive the loop each time.

Other real things worth poking at:
- **`aart_verify`** — the single-call "prove this URL/page actually works" tool (loads it, checks it, screenshots it if it's a browser target). No registration needed first.
- **`aart bundle <id> --environment staging`** — produces a real, content-addressed deployment bundle (`manifest.json` + `definitions/` + `packs/` + `registry/` + `triggers.json`) once you've deployed to an environment (part (d)'s `aart deploy` step) — see part (f) above for what to do with it once you have it.
- **`aart_deploy`** (D1 "remotes + push," `AMENDMENTS.md` A56) — your coding agent can push a workflow version straight to a remote `aart server` over HTTP in one tool call, same underlying mechanism as `aart push` (part (f) above). Ask it to preview first — `{"remote": "production", "workflowId": "...", "workflowVersion": "...", "plan": true}` — before actually pushing.
- **`aart flag list`** / **`aart flag clear <runId> --by <name>`** — the one CLI/dashboard-only action deliberately not exposed over MCP (architecture §13.3: un-flagging a poison/reclaim-exhausted run stays a human judgment call).

---

## What doesn't work yet

Stated plainly, not glossed over:

- **`llm.*` blocks** (`llm.extract`/`llm.classify`/`llm.judge`) are wired for real — the real Anthropic provider adapter, real schema validation, real retry logic — but **untested end-to-end in this session**: no Anthropic API key is available in the environment this was built in. Set `ANTHROPIC_API_KEY` and they should work; this wasn't verified here.
- **The dashboard's `resumeApproval` (per-run wait continuation) and report rendering** still use `DashboardDeps`'s own local implementations rather than `@aart/engine`'s/`@aart/evidence`'s real ones (see part (e)'s note) — narrower than it sounds: `AMENDMENTS.md` A47 closed the store-divergence class for every OTHER dashboard read/write (including trigger-a-run, which now uses the real `EngineBoundary.startRun`), and neither of these two remaining stubs was ever store-path-dependent, so neither was part of that bug class. Not yet wired to the real composition root.
- **The dashboard's new SPA (`AMENDMENTS.md` B1) has no Blocks/Packs page** — `GET /api/blocks`, `/api/blocks/:id`, `/api/packs` are still real, live JSON endpoints (the underlying data/logic is untouched), the founder's SPA rewrite just hasn't added a UI page for them yet; `/blocks/...` in a browser silently falls back to the Runs page. Also not yet in the npm CLI artifact at all — `@aart/dashboard` remains private/workspace-only, reachable only from this repo or the deploy kit's container launcher (part (e), `DEPLOY.md`) — an S8-integration follow-up, not built here.
- **`aart server`'s real trigger wiring never resolved webhook/github/slack HMAC secrets, and `--environment`/`--store`/`--root` didn't exist** — true as of `AMENDMENTS.md` A44; closed A45. See part (f) above for the live webhook proof and the flags.
- **Pack-delivered blocks** aren't in the real block catalog yet (documented gap, `real-context.ts`) — only the 56 core built-ins (`@aart/blocks-core` + `@aart/llm`) are dispatchable today, on a fresh store with no packs installed.
- **`isolated-vm`'s `engines.node: ">=26.0.0"`** vs. this machine's v22.22.2 (part (a)'s install warning) — pre-existing, not new, not addressed here.
- **A `schedule`-fired trigger has no environment concept to gate by** — `AMENDMENTS.md` A48's fix threads a deployment's real target environment into every webhook/github/slack/poll/queue/database/email/file/sdk trigger's capability-dispatch gating (architecture §4.6), but `Schedule` store records (architecture §5.3's frozen shape) carry no `environmentId` field at all, unlike `Deployment`. A schedule-fired run today is gated by the hosting worker/server process's own ambient trust mode (`"governed"` in a correctly-configured deployment — not the old A48 bug's unconditional `"dev"` bypass), not the specific environment a human might expect. Closing this fully needs a `Schedule`-schema migration, out of A48's scope — flagged for whichever session next touches scheduling.
