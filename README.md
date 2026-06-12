# aart — Agentic Automation RunTime

> AI creates reusable automation blocks and workflows. Users govern them.
> A runtime executes them deterministically. Reports prove it.

`aart` is a **workflow & automation framework for AI agents**: it turns an
agent's one-off work into **reusable, user-approved, evidence-producing
automations** — web tasks, API workflows, data pulls, recurring checks, and
(as one flagship use case) QA and release verification. Your agent (Claude
Code, Codex, …) authors a workflow; aart validates it, you approve it once in
chat, and every run leaves a structured report (per-step trace, pass/fail,
screenshots). aart never calls an LLM — the agent does the authoring; aart is
the governed runtime.

Ships with a **core pack** (browser, HTTP, assertions) — and agents can extend
it with their own blocks: npm-powered `node` blocks and workspace packs. Drive
it from your agent over **MCP**, or from the **CLI**.

## Install

```bash
npm i -g @team-monet/aart      # installs the `aart` command
aart doctor                    # checks Node + sandbox + browser, with fix hints

# for the browser blocks (browser.*), download Chromium + its system libs:
npx playwright install --with-deps chromium
```

- **Node ≥ 20** required — both at runtime and to build from source. The
  `node`-block sandbox (`isolated-vm`) and its tests need **Node ≥ 22**; on
  Node 20 the sandbox is absent and custom `node` blocks are unavailable.
- The `node`-block sandbox (`isolated-vm`) is an **optional, prebuilt** native
  addon — install needs **no compiler** on macOS (Apple Silicon), Linux x64/arm64
  (including WSL2), or Windows x64. If it can't install, aart still works; only
  custom `node` blocks need it (`npm i isolated-vm`).

Verify it's working:

```bash
aart --help
aart list        # shows the built-in core blocks (browser.*, http.*, data.*, file.*, flow.*, assert.*)
```

## Use it with your coding agent (recommended)

Point your agent's MCP config at aart (no global install needed for this path):

```json
{ "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"] }
```

No configuration is required to start — with nothing set, aart uses a per-user
default workspace (`~/.aart`), created on first run. To scope a project's blocks,
runs, and approvals to **that project** (its own registry/approvals/secrets),
point it at the project directory:

```json
{ "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"],
  "env": { "AART_WORKSPACE": "/path/to/your/project" } }
```

Then just ask, e.g. *"using aart, check my app at http://localhost:3000 shows the
dashboard."* The agent discovers the blocks, drafts a workflow, **shows you what
it does and asks you to approve it in chat**, runs it, and shows you the report.

### Prime your agent (recommended)

So the agent reaches for aart *before* you have to ask, paste this into your
project's `AGENTS.md` / `CLAUDE.md` / agent rules:

```md
You have aart available via MCP — a workflow/automation framework, not just a
test runner. When a task is worth running again, should be trustworthy, or
should become a durable asset — author an aart workflow instead of a one-off
shell command. aart saves it (named/versioned), the user approves it once, and
every run leaves an evidence report (per-step trace, pass/fail, screenshots).
Good fits: recurring web/API automations, data pulls, report generation,
smoke/health checks, release verification. Use shell for one-off probes; a
durable automation that needs a library can declare npm `dependencies`
(approval-gated). Loop: aa_list_blocks → draft → aa_validate →
aa_register_block → show the user & ask → aa_approve → aa_run_workflow.
```

## What you can build

Compose workflows from the built-in primitives — no custom code needed for
most web/HTTP work:

- **Web automations** — `browser.*`: navigate, fill, click, read the rendered
  page as data (`extract_text`, `html`), query the live DOM (`eval`), screenshot.
- **API workflows & integrations** — `http.request` (any method, headers, auth
  via `{{secrets.X}}`): chain calls, branch on responses with `if/then/else`.
- **Data, files & reports** — `data.parse`/`data.stringify` (JSON/YAML/CSV),
  workspace-scoped `file.read`/`file.write`, `http.download`, and
  `artifact.write` to attach generated reports to the run's evidence. `flow.sleep`
  + step jumps give you polling loops; `flow.fail` gives branches a clean exit.
- **Governed host commands** — a `command` block wraps a CLI you'd otherwise
  shell out to (`git`, `gh`, `kubectl`, builds). You approve the **exact
  command shape** (fixed binary + argv template, spawned without a shell);
  inputs fill argv slots only, and every execution lands in run history —
  shell work becomes an audit trail instead of scrollback.
- **Custom logic** — a sandboxed `node` block parses/transforms data
  between steps. Declare `dependencies` (npm packages / `node:` built-ins) and
  it runs as **real Node.js with those libraries** instead — approval-gated.
- **QA & release verification** — the same primitives plus `assert.*` and
  evidence reports make smoke tests, acceptance checks, and post-deploy
  verification a flagship use case (re-run on every deploy with proof).
- **Your own native blocks** — agents can author **workspace packs**
  (`.aa/packs/<name>`): families of trusted blocks plus shared capabilities
  (long-lived sessions, clients). Registering a pack records a content hash and
  **never executes it**; it loads only after you approve, and any edit breaks
  the seal until re-approved.

(Until 0.4 the core blocks were namespaced `qa.*` — those ids resolve forever,
so existing workflows keep running.)

Custom code is sandboxed by default (a pure-compute V8 isolate). Everything
more powerful is **approval-gated, not impossible**: dependency-bearing blocks
and workspace packs run unsandboxed — the approval summary says so in plain
words, and nothing runs until you agree. aart never runs ad-hoc shell commands.

## See what ran

`aart dashboard` serves a **local, read-only** web UI (127.0.0.1 only): the
block catalog with approval status, run history with per-step traces and
inputs/outputs, inline screenshots and artifacts, and workspace-pack status.
Approval and registration stay in the governed chat/CLI flows — the dashboard
only shows evidence.

## Governance (the approval gate)

Every registration lands as **`draft`** and can't run until approved. Approval is
**conversational**: the agent shows you what a workflow does and asks; when you
say yes it records the approval. You never have to touch a terminal.

- A draft can't run until approved (referenced blocks must be approved too).
  Editing + re-registering resets it to `draft`, so the agent asks again.
- Prefer a stricter, out-of-band gate? Set `AART_STRICT_APPROVAL=1` — then only
  the CLI `aart approve <id>` (run by you) can approve. Review any time with
  `aart show <id>`.

## Secrets & workspace

- **Workspace** — state lives under `<workspace>/.aa` (created on first run). Resolution:
  `--workspace <dir>` → `$AART_WORKSPACE` → nearest ancestor directory containing `.aa` →
  a per-user default `~/.aart`. Upward `.aa` discovery means once a project has a workspace,
  `aart dashboard` and the CLI find it from anywhere inside the tree. With nothing pinned and
  no `.aa` nearby, aart uses `~/.aart` (not the cwd), so it never writes a stray workspace into
  the wrong place. Set **`AART_WORKSPACE`** (or `--workspace`) to scope a workspace to a project.
- **Secrets** — reference credentials as `{{secrets.NAME}}`, sourced from
  `AART_SECRET_<NAME>` env vars or `<workspace>/.aa/secrets.json`. They're
  best-effort **redacted** from reports — never put a real secret in an input.
  (Screenshot *contents* aren't scrubbed; mask secret fields via the screenshot
  block's `mask` option.)

## CLI

The agent does everything via MCP, but the same is available as commands:

```
aart list [--json]            list blocks (with approval status)
aart context                  the full authoring guide + catalog + schema
aart validate <file>          validate a draft definition
aart block add <file>         register a definition (lands as draft)
aart show / approve <id>      review / approve a definition
aart pack register|approve|list <name>   workspace packs (agent-authored native blocks)
aart run <id|file> [--yes]    run a workflow → report
aart report <runId>           replay a past report
aart dashboard [--port 4400]  local read-only web UI: blocks, run history, artifacts
aart doctor                   check setup
aart mcp                      start the MCP server (stdio)
```

## WSL2 / Linux notes

- aart runs **its own headless Chromium** Linux-side (not your Windows Chrome);
  no display needed. Use `npx playwright install --with-deps chromium`.
- **Target URL:** an app *inside* WSL2 is at `http://localhost:PORT`. An app on
  the **Windows host** isn't reachable via `localhost` under default WSL2 NAT —
  use the host IP or mirrored networking (`.wslconfig` →
  `[wsl2] networkingMode=mirrored`, Win11 22H2+). Remote URLs just work.
- Keep the project off `/mnt/c/…` (slow 9p I/O).

## License

Apache-2.0
