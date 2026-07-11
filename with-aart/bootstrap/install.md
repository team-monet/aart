# AART — agent-first install playbook

**You are the user's coding agent.** The user pasted a one-line request to set up AART. Your job is to install and configure it *for* them — running the commands yourself, conversing at each decision point, and diagnosing/fixing failures as you go. **Do not ask the user to clone a repo or run shell scripts themselves.** Adapt to their host and preferences.

Work through the phases in order. After each, tell the user what happened in one line. If a step fails, show the error, explain the likely cause, propose a fix, and retry — never leave a half-configured state.

**This playbook needs no separate prompt files.** Unlike some agent-onboarding bootstraps, with-aart installs exactly one piece of content — the working-instructions block in Phase 4 — and that content is never fetched as static prose from this repo; it's generated on the spot by actually running `aart init-agent` (see Phase 4). Everything else here is procedure for you to execute, not content to relay verbatim.

**Read this file itself from one of:**
- a local `aart` checkout if one exists (prefer it — you'll need one anyway for Phase 2 pre-1.0.0), else
- this repo's raw URL: `https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md`.

(Raw fetch needs the repo to be **public** — `team-monet/aart` is; if you can't reach it, that's the one time to ask the user to clone the repo and point you at the local path instead.)

**One honest difference from other agent-onboarding bootstraps you may know, stated up front:** AART is pre-`1.0.0`. `@team-monet/aart` is claimed on npm but the published version there predates this repo's current architecture (see `AUTHORING.md` part (b) in this repo — the exact proof, reproduced for you in Phase 2). That means Phase 2 below requires an actual `git clone` + from-source build, not a one-line `npm i -g`. Once this package genuinely reaches `1.0.0`, Phase 2 collapses to a single global-install line and no clone is needed to run this playbook at all — flagged inline below for whoever revisits this file after that ships.

---

## Updating an existing install

Already set up? Re-running this whole playbook is safe and idempotent: Phase 3 (`aart init-agent`) merges into `.mcp.json` rather than clobbering it (AMENDMENTS.md A55), and Phase 4 replaces its global block in place using its own markers. If you only want the latest global working instructions refreshed, skip straight to Phase 4 — but re-fetch this file first so you're applying the current phase, not a cached copy. Then run Phase 5 to confirm the refreshed block actually loaded (if your host only reads its global instruction file at launch, you'll need to reload/restart first).

---

## Phase 1 — Orient

1. **Identify your host and its install surfaces.** You're the agent running inside it, so you know — or its docs do — where it keeps:
   - (a) its **MCP server config**, at **project/repo scope** (e.g. Claude Code's `.mcp.json` at the repo root). AART always needs this, per workspace — see Phase 3 for why this can never be a one-time global step.
   - (b) its **always-on global instruction surface**, if it has one (e.g. Claude Code's user-level `~/.claude/CLAUDE.md`). Some hosts have no such surface — that's fine, it just means Phase 4 isn't available there; Phase 3 (which every MCP-capable host supports) still is.

   Note one capability that gates the MCP-tool half of this install:
   - **MCP support — required for the tool-driven authoring loop.** AART is an MCP server; `aart_find_blocks`/`aart_verify`/`aart_run_workflow`/etc. only reach the agent over MCP. If the host can't run MCP servers, its coding agent can't use AART's tools — but say so plainly rather than stopping outright: **AART's CLI works standalone regardless** (`aart run`, `aart register`, `aart validate`, ...), so a non-MCP host can still be pointed at "run these `aart` commands by hand" instead of getting the agent-driven loop.
   - **Unlike some multi-agent onboarding bootstraps you may know, there is no "real isolated subagents" requirement here.** AART has no team to install — one coding agent, calling AART's MCP tools directly, is the whole model. Any MCP-capable host qualifies, regardless of whether it supports named subagents at all.

   Also note whether the host loads MCP servers / global instructions only at launch (you'll tell the user to reload afterward). Anything unclear — check the host's docs or ask the user; don't guess.
2. Confirm: *"You're on **<host>**. I'll wire AART into this workspace (`aart init-agent`) and, if you'd like, install its working instructions globally so every AART-enabled project gets the reflex without a fresh copy each time. Anything special about your setup?"*

## Phase 2 — Get AART

Goal: a real, working `aart` binary on this machine.

**Right now (pre-`1.0.0`): install from source.** Do **not** run `npm i -g @team-monet/aart` — that resolves the already-published `0.9.0`, an older, architecturally incompatible CLI (proof: `AUTHORING.md` part (b) in this repo, reproduced there verbatim from a genuine fresh clone — `-w/--workspace`, `aart doctor`, none of which exist in this repo's real command surface). Follow `AUTHORING.md` part (b)'s exact commands instead (clone, `corepack enable && corepack prepare pnpm@<pinned version> --activate`, `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm --filter @team-monet/aart run build:publish`, `pnpm pack`, `npm install -g <tarball>`) — execute them verbatim from that file rather than re-deriving them here; they're independently verified end-to-end (AMENDMENTS.md A54) and re-verifying them is Phase 2's own job, not this playbook's to restate. Confirm `aart --help` prints this repo's real usage block (`aart run`, `aart register`, `aart mcp`, `aart init-agent`, ...) — if you see `-w/--workspace` or `aart doctor` instead, something resolved the stale registry package; you're in the trap `AUTHORING.md` part (b) documents.

**Once genuinely `1.0.0`:** `npm i -g @team-monet/aart` (no clone needed — matches how `with-monet` installs `monet`). Before trusting a bare `npm i -g` at that point, sanity-check that the registry has actually caught up: `npm view @team-monet/aart dist-tags` against this repo's own `packages/cli/package.json` version, and confirm `aart --help`'s output matches `packages/cli/src/cli.ts`'s `USAGE` string.

## Phase 3 — Configure the MCP server (per workspace — never a one-time global step)

**Structural fact, not a preference:** AART's store (`.aart/`, like a project's own `.git/`) is workspace-scoped by design — every project has its own store. That means the MCP wiring that points an agent at it is workspace-scoped too. Unlike some MCP servers that register once at user scope and cover every project (a single shared server backed by one global store), there is no "install AART once for all projects" step for the MCP server itself — you repeat this phase for each workspace the user wants to author or run AART workflows in.

For **each** such workspace:
```bash
cd <workspace>
aart init-agent
```
This writes, right there, two files:
- **`.mcp.json`** — the real MCP server config, pointing at whichever `aart` binary is actually running `init-agent` (self-consistent by construction: `{"command": "node", "args": ["<absolute path to your install>", "mcp"]}`, resolved from `process.argv[1]` — AMENDMENTS.md A54 closed the trap where a naive `npx`-based config silently resolved the wrong, stale package instead). **Merge-safe** (AMENDMENTS.md A55): if `.mcp.json` already has other servers registered here — very plausible, e.g. a `monet` entry from this same founder's own `with-monet` install — `aart init-agent` reads the existing file, replaces only its own `aart` key, and writes the rest back untouched. It does not delete siblings, and a `.mcp.json` that exists but isn't valid JSON is left on disk and reported as an error rather than silently replaced.
- **`AGENTS.md`** — this workspace's own copy of AART's working instructions (the verify reflex, the authoring loop, this project's actual approval semantics for whatever trust mode it's configured with). Claude Code (or any host that reads `AGENTS.md`) picks this up automatically, scoped to this one repo — this happens regardless of whether you do Phase 4 below.

Re-running `aart init-agent` in a workspace is always safe — it's the documented way to refresh both files after an AART upgrade (`AUTHORING.md` part (f)).

## Phase 4 — Install the working instructions globally (ask first)

**This is the install's highest-impact write — its own decision point, same as any change to how every session on this machine starts.** Ask explicitly: *"Install AART's working instructions — the verify reflex, the authoring loop — in your [host's global instruction file], so every AART-enabled project gets them without a per-project copy? This changes how every session on this machine starts."* A general "go ahead with the install" does not cover this — wait for an explicit yes.

On yes:

1. **Generate the canonical text — never hand-write or paraphrase it.** In a scratch directory that is *not* a real project (a fresh temp dir is fine):
   ```bash
   aart init-agent --mcp-config-out <scratch>/.mcp.json --instructions-out <scratch>/AGENTS.md
   ```
   Read `<scratch>/AGENTS.md` — its content, verbatim, byte for byte, is the block you install. Discard the scratch directory afterward (its `.mcp.json` means nothing outside a real workspace; don't reuse it). This is the whole point of generating rather than copying: `with-aart` and `aart init-agent` must always emit the *same* text, from the *same* source (`generateInitAgentOutputs` in `packages/mcp/src/init-agent.ts` — see that file's own header comment, AMENDMENTS.md A55) — never a second, independently hand-maintained copy that can silently drift from the real one.

   A scratch directory has no real trust-mode configuration, so this generates the **governed**-mode approval section (the platform default when nothing else is configured). If the user runs a different trust mode somewhere, say so plainly: the global copy's approval section is representative, not authoritative for every project — each workspace's own `AGENTS.md` (Phase 3) or its actual configured mode is the source of truth for *that* project's approval semantics. The verify reflex and the authoring loop, which is most of the document, don't vary by mode at all.

2. **Write it into the host's global instruction file, wrapped in idempotent markers:**
   ```
   <!-- BEGIN with-aart:agent -->
   …the generated AGENTS.md body…
   <!-- END with-aart:agent -->
   ```
   - **Back up first** (`<file>.bak`).
   - **Append — never replace the file's existing content.** The user may already have other standing instructions there (most likely candidate: a `with-monet` install's own Stig persona, wrapped in its own `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers). AART's instructions and a with-monet lead persona are complementary, not competing — both can and should coexist in the same file.
   - **If `with-aart:agent` markers already exist** (re-running this phase, or the "updating" flow above), replace just that block in place — never append a second copy.
   - **If the host's instruction file requires frontmatter** (some hosts' rule files do), keep the markers and body *below* it — a leading HTML comment can break the file's own activation metadata.
   - Show the user the exact diff before writing, and proceed only once they've seen it.
3. **Tell the user to reload/restart the host** if it only loads its global instruction file at launch (Claude Code does) — otherwise the running session keeps whatever it already had until then.

## Phase 5 — Verify the install

Confirm both halves before wrapping up — don't claim success from the write succeeding alone:

1. **The MCP wiring actually works.** In a workspace from Phase 3, list AART's registered tools (Claude Code: `/mcp`, or just call a tool directly) and confirm `aart_find_blocks` is among them — 16 tools on a bare-fresh project (5 more unlock once an `Environment`/`EvalSuite` exists in that workspace's store, `AUTHORING.md` part (c)). Then actually **call** `aart_find_blocks` (a query like `"http"`, or no query for the full catalog) and report a compact summary of what came back — a tool appearing in the list only proves registration, not that the server behind it actually runs. If the list is empty or the call errors, don't assume AART itself is broken: check what's literally at the other end of `.mcp.json`'s `command`/`args` first (a stale absolute path after a reinstall fails exactly this way — `AUTHORING.md` part (f)).
2. **The global instructions reached the agent**, if Phase 4 ran. In a *new* session (reload first if the host needs it), confirm the host's own context includes the `with-aart:agent` block — e.g. ask the agent to describe AART's verify reflex without being told anything; if it can, the block loaded. If it can't after a reload, the write likely landed in the wrong file or location for this host — re-check Phase 1's orientation rather than re-writing blindly.

**No standalone local dashboard here, unlike some substrate MCP servers you may know:** `@aart/dashboard` is a server-side surface — it runs against a live `aart server`'s HTTP API (`DEPLOY.md`), not against a local authoring store, and isn't part of what Phase 2's from-source install produces (`AUTHORING.md` part (g)). Don't offer one.

## Phase 6 — One last thing (star the repo)

Once the install is working, ask the user once — lightly, no pressure:

> *"If AART's earning its keep: I can ⭐ star **team-monet/aart** for you (a quick `gh` command you approve). Want that?"*

If they want to star, check `gh` is usable (`gh auth status`); if so, run it with their explicit approval:
```bash
gh api --method PUT /user/starred/team-monet/aart
```
If `gh` is missing or unauthenticated, fall back to the link: `https://github.com/team-monet/aart` and let them star manually. Ask once; don't nag; never act without a yes.

---

## Host notes

<details>
<summary><strong>Claude Code</strong></summary>

- Global surface: `~/.claude/CLAUDE.md` (user scope). Project surfaces: `AGENTS.md` at the repo root (read automatically) and `.mcp.json` at the repo root (connected automatically at session start; a fresh write needs a reload to take effect).
- **Subagents (the Task tool's named workers — e.g. a with-monet-style `developer`) inherit the project's `.mcp.json` connections, so AART's tools ARE reachable from inside them, but they do NOT inherit the user-level `~/.claude/CLAUDE.md`** — only the main session reads that file. A subagent that needs the verify-reflex/authoring-loop framing needs it *injected into its own briefing* by whichever lead delegates to it. If the user runs a with-monet-style lead (Stig), this composes for free: Stig's own context-injection discipline already folds "a governing workflow that applies to the task" into a worker's briefing as an imperative — Phase 4's global block is exactly the kind of thing that discipline is built to carry forward. with-aart's global install can't reach a subagent directly; it doesn't need to, because the lead it installed into already knows how to relay what matters.

</details>

<details>
<summary><strong>Codex / opencode / other hosts</strong></summary>

Feature-detect per Phase 1 rather than assuming from the host's name. This playbook's own authors have not independently verified these hosts end to end — adapt the two file-location facts (global instruction surface, project MCP config format) to whatever that host's own docs say; the rest of the mechanism (generate via `aart init-agent`, wrap in markers, back up, append) is host-agnostic.

</details>

---

## Principles

- **Agent-first:** you do the install; the user converses, approves, and steers.
- **Fix-forward:** on any failure, diagnose and resolve with the user rather than dumping a stack trace.
- **Permission prompts are checkpoints, not failures:** hosts may challenge writes to a global instruction file because it changes how the agent itself behaves everywhere. That's expected — pause, show the user what you're about to write and why, and proceed on their explicit OK.
- **Non-destructive:** back up before overwriting, merge into existing config rather than replacing it (Phase 3 does this structurally; Phase 4 does it by marker + append), and never clobber the user's own content.
- **One source of truth:** the working-instructions text always comes from actually running `aart init-agent`, never from a copy hand-maintained in this file or anywhere else in `with-aart/`.
