# AART — local test drive

You're testing AART on this machine (macOS, Node v22.22.2, repo at `/Users/johnlee/code/aart`). This is the founder walkthrough: install the real published artifact the way an actual user would, run a real workflow through it, watch a real governed pause get approved, wire it into Claude Code, and start the dashboard/worker/server locally.

**Everything below is real, not simulated.** As of this session (AMENDMENTS.md A42), the CLI's composition root builds the real engine, real governance, real evidence, and a real worker/server/bundle backend by default — `aart run` genuinely dispatches blocks, `aart validate` genuinely checks governance rules, `aart worker`/`aart server` genuinely start real processes with real health endpoints. Every command below was actually run, from an actually-installed tarball, in a directory with zero access to this repo's own `node_modules` — the same install methodology used to prove the CLI is installable at all (AMENDMENTS.md A33/A35). Where something doesn't work yet, that's called out explicitly in [What doesn't work yet](#what-doesnt-work-yet), not glossed over.

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

**A second real governance moment, worth trying**: validate a version of the workflow that also writes a file (`artifact.write`, capability `file.write`) —

```yaml
  - id: save
    uses: artifact.write
    with: { name: "greeting.json", kind: "json_output", mime: "application/json", content: "{{ steps.greet.outputs.output }}" }
```

`aart validate` genuinely reports a real `capability`-class finding ("Capability \"file.write\" is required... not yet approved") — real 5-class validation (schema/reference/capability/input-safety/deployment), not a rubber stamp.

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

**The server** (control plane — webhooks, approvals, the `/health`/`/runs`/`/waiting-runs`/... read API):

```bash
cd ~/aart-test-drive
aart server --port 8080
```
Open **http://localhost:8080/health** → `{"status":"ok"}`. Try **http://localhost:8080/runs** and **http://localhost:8080/workflows** too — real data from your `.aart` store. `Ctrl-C` stops it cleanly (prints `"Server stopped."`).

**The worker** (claims and executes runs from `job_queue`), in a second terminal:

```bash
cd ~/aart-test-drive
aart worker
```
Open **http://localhost:8787/health** → `{"status":"ok","claimedRuns":0,"uptime":...}` (a separate port from the server's own health, by design — ADR-16). `Ctrl-C` stops it cleanly too (`"Worker stopped."`).

**The dashboard** is a private, workspace-only package (`@aart/dashboard`, never published — it's not part of the CLI's own bundle) — you run it from this repo, not from the installed tarball. It has no bin/dev script yet, so save this as e.g. `~/aart-test-drive/dashboard-dev.mjs` and run it with plain `node` (after `pnpm run build` in the repo, so `packages/dashboard/dist` exists):

```js
// dashboard-dev.mjs — @aart/dashboard's own documented composition-root
// usage (packages/dashboard/src/index.ts's header comment), run standalone.
// Needs aart server already running on :8080 (started above) for its
// /runs and /workflows pages — everything else (health, blocks) works
// without it. Run this FROM ~/aart-test-drive (where you saved it) — the
// relative "./.aart" path below resolves against whatever directory you
// launch `node` from, same as `aart server`'s own default.
import { createFsStore } from "/Users/johnlee/code/aart/packages/store/dist/index.js";
import { startDashboard, createHttpApiClient, createStubDeps } from "/Users/johnlee/code/aart/packages/dashboard/dist/index.js";

const store = createFsStore("./.aart");
const handle = await startDashboard({
  store,
  api: createHttpApiClient("http://localhost:8080"),
  deps: createStubDeps(store),
  workerUrls: ["http://localhost:8787"],
  port: 4000,
});
console.log(`dashboard on http://localhost:${handle.port}`);
```

```bash
node dashboard-dev.mjs
```

Open **http://localhost:4000/runs** — your real registered runs. **http://localhost:4000/workflows**, **http://localhost:4000/blocks**, **http://localhost:4000/waiting-runs**, **http://localhost:4000/approvals** are all real too (verified: 200s, real data, with `aart server` running alongside). Click through into a workflow (**http://localhost:4000/workflows/smoke-data-pipeline**) or a block (**http://localhost:4000/blocks/data.stringify**) for its detail page — both now real (root AMENDMENTS.md A43; previously workflow detail 404'd and block detail didn't exist as a page at all).

**A previous version of this exact script had a footgun**: it hard-coded an absolute placeholder path (`/Users/YOU/aart-test-drive/.aart`) you had to manually edit to your own home directory. Miss that edit — easy to do on a copy-paste — and `createFsStore` silently points at a directory that doesn't exist; every dashboard page that read straight from that store handle (workflow detail chief among them) 404'd on data that demonstrably existed, while list pages kept working fine (they read through `aart server`'s own HTTP API instead, which was never affected). That's exactly the bug root AMENDMENTS.md A43 found and fixed from a real local test drive — the script above now uses a relative path so there's nothing to individually substitute, and workflow/block detail no longer depend on this script's own store handle being correctly configured at all (they read through the API/catalog like every other page now).

Honest note on the dashboard specifically: its write actions (`DashboardDeps`) are still a documented partial-stub — real governance/promotion/risk-diff, but `redact`/`triggerRun`/`resumeApproval`/evidence-report-rendering are still local mirrors (`packages/dashboard/src/stub-deps.ts`'s own header comment). That's a pre-existing, separately-tracked gap this session didn't touch — the composition-root decision this session implemented was scoped to `packages/cli` specifically (architecture's three-client principle: three separate composition roots, not one shared one).

---

## (f) What to try next

The real payoff of the MCP wiring in part (d) is having your coding agent **author** a workflow, not just run one you hand-wrote. With `aart mcp` connected in Claude Code:

> "Use the aart tools to find a block that checks an HTTP endpoint, draft a workflow that hits `https://example.com` and asserts the response contains 'Example', register it, validate it, run it, and show me the report."

That's the exact loop `AGENTS.md` (part (d)) describes: `aart_find_blocks` → draft with `uses`/`with` → `aart_register_block` → `aart_validate` (fix any findings) → `aart_run_workflow` → `aart_get_report`. Every tool result's own `next` field tells the agent what to do next, so it doesn't need to re-derive the loop each time.

Other real things worth poking at:
- **`aart_verify`** — the single-call "prove this URL/page actually works" tool (loads it, checks it, screenshots it if it's a browser target). No registration needed first.
- **`aart bundle <id> --environment staging`** — produces a real, content-addressed deployment bundle (`manifest.json` + `definitions/` + `packs/` + `registry/` + `triggers.json`) once you've deployed to an environment (part (d)'s `aart deploy` step). An unknown `--environment` name fails with a clear error rather than silently producing a broken bundle.
- **`aart flag list`** / **`aart flag clear <runId> --by <name>`** — the one CLI/dashboard-only action deliberately not exposed over MCP (architecture §13.3: un-flagging a poison/reclaim-exhausted run stays a human judgment call).

---

## What doesn't work yet

Stated plainly, not glossed over:

- **`llm.*` blocks** (`llm.extract`/`llm.classify`/`llm.judge`) are wired for real — the real Anthropic provider adapter, real schema validation, real retry logic — but **untested end-to-end in this session**: no Anthropic API key is available in the environment this was built in. Set `ANTHROPIC_API_KEY` and they should work; this wasn't verified here.
- **The dashboard's write actions** are still a documented partial stub (see part (e)'s note) — read pages are real, some write actions (approve/promote/risk-diff) are real, others (trigger a run, resume an approval, render a report) are still local mirrors pending their own composition-root wiring pass. Not this session's scope.
- **No `LICENSE` file** — deliberately deferred; `packages/cli/README.md`'s existing "no license chosen, treat as all-rights-reserved" flag is unchanged.
- **Pack-delivered blocks** aren't in the real block catalog yet (documented gap, `real-context.ts`) — only the 56 core built-ins (`@aart/blocks-core` + `@aart/llm`) are dispatchable today, on a fresh store with no packs installed.
- **`isolated-vm`'s `engines.node: ">=26.0.0"`** vs. this machine's v22.22.2 (part (a)'s install warning) — pre-existing, not new, not addressed here.
