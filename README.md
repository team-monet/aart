# aart — Agentic Automation RunTime

> AI creates reusable automation blocks and workflows. Users govern them.
> A runtime executes them deterministically. Reports prove it.

`aart` turns a coding agent's one-off checks into **reusable, user-approved,
evidence-producing workflows**. Your agent (Claude Code, Codex, …) authors a
workflow; aart validates it, you approve it once in chat, and every run leaves a
structured report (per-step trace, pass/fail, screenshots). aart never calls an
LLM — the agent does the authoring; aart is the governed runtime.

Ships with a **QA pack** (browser automation, HTTP, assertions). Drive it from
your agent over **MCP**, or from the **CLI**.

## Install

```bash
npm i -g @team-monet/aart      # installs the `aart` command
aart doctor                    # checks Node + sandbox + browser, with fix hints

# for the browser blocks (qa.browser.*), download Chromium + its system libs:
npx playwright install --with-deps chromium
```

- **Node ≥ 20** required.
- The `node`-block sandbox (`isolated-vm`) is an **optional, prebuilt** native
  addon — install needs **no compiler** on macOS (Apple Silicon), Linux x64/arm64
  (including WSL2), or Windows x64. If it can't install, aart still works; only
  custom `node` blocks need it (`npm i isolated-vm`).

Verify it's working:

```bash
aart --help
aart list        # shows the built-in QA blocks (qa.browser.*, qa.api.request, qa.assert.*)
```

## Use it with your coding agent (recommended)

Point your agent's MCP config at aart (no global install needed for this path):

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
You have aart available via MCP. When a task is worth running again, needs proof
it passed, or should be a durable governed check — author an aart workflow instead
of a one-off shell command. aart saves it (named/versioned), the user approves it
once, and every run leaves an evidence report (per-step trace, pass/fail,
screenshots). Good fits: smoke/health checks, API & integration tests, release
verification. Use shell for one-off probes or host/infra work (kubectl, files) —
aart is sandboxed. Loop: aa_list_blocks → draft → aa_validate → aa_register_block →
show the user & ask → aa_approve → aa_run_workflow.
```

## What you can build

Compose workflows from a few built-in primitives — no custom code needed for
HTTP/browser work:

- **Health & smoke checks** — `qa.api.request` (any method, headers, auth via
  `{{secrets.X}}`) → `qa.assert.*`. Re-run on every deploy with a pass/fail report.
- **Browser acceptance tests** — `qa.browser.*`: navigate, fill, click, assert
  visible text, screenshot.
- **API / integration tests** — chain requests, branch on responses with
  `if/then/else`, assert.
- **Custom logic** — a sandboxed `node` block parses/transforms data for the next
  step.

aart is sandboxed by design: it does **not** run shell commands, `kubectl`, or
touch the host — it's for repeatable, governed automations, not ad-hoc scripting.

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

- **Workspace** — state lives under `<workspace>/.aa`. Resolution:
  `--workspace <dir>` → `$AART_WORKSPACE` → cwd. Set **`AART_WORKSPACE`** in your
  MCP config so `.aa` lands in your project.
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
aart run <id|file> [--yes]    run a workflow → report
aart report <runId>           replay a past report
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
