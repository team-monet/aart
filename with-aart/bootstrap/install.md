# AART — agent-first install playbook

**You are the user's coding agent.** The user pasted a one-line request to set up AART. Your job is to install and configure it *for* them: run every command yourself, confirm at each decision point below, and diagnose/fix failures as you go. **Never ask the user to clone a repo or run shell scripts themselves** — you are the one running them. Adapt to their host; don't skip steps because they seem obvious.

Work through the phases in order. After each, tell the user what happened in one line. If a step fails, show the error, explain the likely cause, propose a fix, and retry — never leave a half-configured state.

**Scope: local authoring workspace only.** This playbook wires an MCP server and working instructions into one or more local workspaces on this machine. It never touches a remote/deployed `aart server`, `aart deploy`, or the dashboard (`@aart/dashboard` runs against a live server's HTTP API, not a local authoring store) — that's `DEPLOY.md`/`AUTHORING.md` part (g) territory, out of scope here by design. Don't offer it.

**This playbook needs no separate prompt files.** The only content it installs — the working-instructions block used in Phase 4 and Phase 5 — is never fetched as static prose from this repo. It's generated on the spot by actually running `aart init-agent`. Everything else here is procedure for you to execute, not content to relay verbatim.

**Read this file itself from one of:**
- a local `aart` checkout if one exists, else
- this repo's raw URL: `https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md`.

(Raw fetch needs the repo to be **public** — `team-monet/aart` is; if you can't reach it, that's the one time to ask the user to clone the repo and point you at the local path instead.)

**Default install mode is zero-install.** As of `0.10.0`, every `aart` invocation in this playbook runs as `npx -y @team-monet/aart <cmd>` — no `npm install -g` required for the common case. Phase 3 covers this, including the one opt-in reason to install globally anyway. AART remains pre-`1.0.0` (beta) — 0.x releases may still carry breaking changes, so this playbook always sanity-checks the resolved version before trusting it (Phase 2, Phase 3).

---

## Updating an existing install

Already set up? Re-running this whole playbook is safe and idempotent: Phase 4 (`aart init-agent`) merges into `.mcp.json`/`opencode.json` rather than clobbering it, and Phase 5 replaces its global block in place using its own markers. If you only want the latest global working instructions refreshed, skip to Phase 5 — but re-fetch this file first so you're applying the current phase, not a cached copy. Then run Phase 6 to confirm the refreshed block actually loaded (reload/restart first if your host only reads its global instruction file at launch).

---

## Phase 1 — Orient

You're the agent running inside the host, so you already know which one it is. Find its entry below and use its facts verbatim — don't adapt, don't guess, don't go check that host's own docs if it's listed here.

### Claude Code
- **Project MCP config:** `.mcp.json` (repo root):
  ```json
  {
    "mcpServers": {
      "aart": { "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"] }
    }
  }
  ```
- **Project instructions:** `CLAUDE.md` (repo root). **Claude Code does NOT read `AGENTS.md`.** `aart init-agent` writes `AGENTS.md` regardless — it's the one canonical source text (Phase 4 explains why) — but on this host its content must *also* land in `CLAUDE.md`, or the agent never sees it.
- **Global instructions surface:** `~/.claude/CLAUDE.md`.

### opencode
- **Project MCP config:** `opencode.json` (repo root):
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "aart": { "type": "local", "command": ["npx", "-y", "@team-monet/aart", "mcp"], "enabled": true }
    }
  }
  ```
  `aart init-agent` always emits the Claude-style `.mcp.json` shape above — it has no opencode-specific output mode. On this host, treat that file as a **template only**: transcribe its `command`/`args` into `opencode.json`'s `mcp.aart` entry exactly as shown (note opencode uses one combined `command` array, not separate `command`+`args` fields), then delete the generated `.mcp.json` — opencode never reads it.
- **Project instructions:** `AGENTS.md` (repo root) — opencode reads this natively, and `aart init-agent`'s own output is already the right file here. No transcription needed.
- **Global surfaces:** `~/.config/opencode/opencode.json` (MCP, if ever needed outside a project) and `~/.config/opencode/AGENTS.md` (instructions — this is the one Phase 5 uses).

### Other hosts
Not independently verified by this playbook's authors — don't invent specifics for a host not listed here. Consult that host's own docs for exactly two facts: (1) where it reads project-scoped MCP server config, (2) where it reads project instructions, and separately, an always-on global instruction file if it has one. Once you have those two paths, the rest of this playbook — generate via `aart init-agent`, wrap in markers, back up, append — is identical regardless of host.

### Before proceeding

1. **Guard: write to the CURRENT host's files ONLY, per the entry above.** Files belonging to other agent hosts found on this machine (e.g. a `~/.claude/CLAUDE.md` sitting on a machine where you're actually running as opencode) are not yours to modify, and never offer them as an option, even helpfully.
2. **MCP-capable?** Everything here needs the host to run MCP servers at all. If it can't: say so plainly, and after Phase 3 stop — AART's CLI (`aart run`, `aart register`, `aart validate`, ...) still works standalone; point the user at running these `aart` commands by hand instead of the tool-driven loop.
3. **Decision point 1 — confirm before wiring anything:** *"You're on **<host>**. I'll wire AART's MCP server into `<project MCP file>` and its instructions into `<project instructions file>` for this workspace, and separately ask before installing anything globally. Anything special about your setup?"*

## Phase 2 — Check the machine (before installing anything)

A machine this playbook runs on may already have `aart` state on it. Check before you add more.

1. **Existing `aart` on PATH?**
   ```bash
   command -v aart >/dev/null 2>&1 && aart --version || echo "no working aart on PATH"
   ```
   - Nothing found: fine, move on.
   - Found, below `0.10.0`: a stale install — `0.1.0`–`0.9.0` were a different, architecturally incompatible CLI that happened to claim this npm name first (flags like `-w/--workspace` or a `doctor` command instead of `run`/`register`/`mcp`/`init-agent` confirm it; see `AUTHORING.md` part (b) if you want the full story). Tell the user. You don't have to fix it: every command in this playbook goes through `npx -y @team-monet/aart`, which resolves the currently-published package fresh and bypasses whatever's on PATH entirely. Only run `npm install -g @team-monet/aart@latest` if the user separately opts into global install (Phase 3) and wants that specific binary updated.
   - Found, `0.10.0` or later: fine either way, no action needed.

2. **Existing store?** Check the conventional shared location:
   ```bash
   [ -d "$HOME/.aart" ] && { echo "found:"; ls -la "$HOME/.aart"; } || echo "no $HOME/.aart"
   ```
   AART has no built-in "shared store" default of its own — left unset, `--root` resolves relative to whatever directory the MCP server process happens to be launched from, which varies by host and isn't worth relying on. So this is really a "which absolute `--root` do I pin" decision, not a "default vs override" one.

   **Decision point 2 — decide the store path, then pin it explicitly in Phase 4 (never leave `--root` unset):**
   - **Shared** — store path `$HOME/.aart`. Blocks, workflows, and evals registered in one project become reusable from every other AART-enabled project on this machine. **Default recommendation** if nothing pre-exists, or if what's there looks current.
   - **Isolated** — store path `<this workspace's absolute path>/.aart`. Nothing shared, nothing inherited. **Recommend this instead** if the store check just above found a pre-existing store that looks like old-version debris (schema from a pre-0.10 install, unrecognized workflows, anything the user doesn't want this workspace inheriting).
   - If nothing pre-exists at all, still offer the choice in one line — default answer is shared.
   - **Carry that exact store path forward to Phase 4, unchanged** — it already ends in `.aart`; that's the full string Phase 4 writes into the MCP args, with nothing appended to it.

## Phase 3 — Get AART

**Default: zero install.** Every `aart` invocation in this playbook is `npx -y @team-monet/aart <cmd>`. `npx` fetches the published package on first use and caches it — nothing to install, nothing on PATH to manage, and (per Phase 2) it bypasses any stale global `aart` automatically. Expect the **first** MCP connect to be slow while npx warms its cache — that's normal, not a hang.

**Global install is opt-in — offer it, don't default to it:** *"Only if you want the `aart` CLI at hand directly — `aart watch` for a local dashboard, or deploying later — otherwise npx covers everything this playbook does."*
```bash
npm install -g @team-monet/aart
```

**Rule, regardless of install mode: MCP wiring always uses the npx form. Never wire MCP to a resolved absolute binary path** (e.g. an nvm-managed path like `/Users/you/.nvm/versions/node/v22.x.x/bin/aart`). That path breaks silently the next time the user switches Node versions — no error, just a dead MCP connection. Concretely: **always pass `--npx` to `aart init-agent`** (Phase 4) — that flag decides whether the generated MCP config gets the npx form or a self-resolved absolute path, independent of whether `aart` itself is globally installed. Global install makes `aart` convenient to run by hand; it is never a reason to point MCP at a fixed path.

**Sanity-check whichever binary you're about to rely on** — confirm `aart --version` (or `npx -y @team-monet/aart --version`) prints `0.10.0` or later before trusting it.

**Never probe `init-agent` with `--help`.** On `0.10.0`, unrecognized flags are silently ignored and `init-agent` still runs its real write action — `aart init-agent --help` writes `.mcp.json`/`AGENTS.md` into the current directory and returns a normal-looking `{"ok":true,...}` (a CLI fix is filed for `0.10.1`). This playbook is the authoritative flag reference: `--npx`, `--mcp-config-out`, `--instructions-out`.

**If npm isn't reachable, or the user wants to pin an exact commit:** install from source instead. Follow `AUTHORING.md` part (b)'s "Installing from source" steps verbatim (clone, `corepack enable`, `corepack prepare pnpm@<pinned version> --activate`, `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm --filter @team-monet/aart run build:publish`, `pnpm run build:dashboard-launcher`, `cd packages/cli`, `pnpm pack`, `npm install -g <tarball>`) — execute from that file rather than re-deriving them here. Same version sanity-check applies afterward.

**Exception to "always npx form": the from-source path itself.** If you just built a custom or unpublished commit specifically to pin it, run `aart init-agent` there **without** `--npx`. Its default (no flag) self-resolves to the exact binary that's running it, which is correct precisely because that build isn't (or might not yet be) what's on the public registry. Using `--npx` in that one case would silently wire MCP to whatever's currently published instead of the custom build you just made — the same silent-wrong-binary failure this whole rule exists to prevent, just pointed the other way. Everywhere else — the common case, a published version — `--npx` is the rule.

## Phase 4 — Wire the MCP server (per workspace — never a one-time global step)

**Structural fact:** AART's store (`.aart/`, like a project's own `.git/`) is workspace-scoped by design. Repeat this phase for every workspace the user wants to author or run AART workflows in — there's no "set up the MCP server once for all projects."

For **each** such workspace:

1. ```bash
   cd <workspace>
   npx -y @team-monet/aart init-agent --npx
   ```
   (The outer `npx` runs the CLI itself; the inner `--npx` flag controls what `init-agent` *writes* into the generated MCP config — two different things, both needed, don't drop either.) Or, if global install was chosen: `aart init-agent --npx` — still with `--npx`, per Phase 3's rule.

   This always writes two files: `.mcp.json` (merge-safe — replaces only its own `aart` key if the file already has other servers registered, e.g. a `monet` entry from a `with-monet` install; leaves an unparseable existing file alone and reports an error rather than clobbering it) and `AGENTS.md` (this workspace's copy of AART's working instructions — the one canonical source, never hand-copied or paraphrased).

2. **Apply Phase 2's store decision.** `init-agent` has no flag for this — edit `.mcp.json`'s `args` array (the file it just wrote), appending:
   ```
   "--root", "<the store path from Phase 2>"
   ```
   Use the exact string Phase 2 settled on, unchanged — it already ends in `.aart`; don't append anything further. Every workspace's config gets this appended — both the shared and the isolated choice are explicit paths, never an unset `--root`.

3. **Per-host finishing step:**
   - **Claude Code:** copy `AGENTS.md`'s content into this workspace's `CLAUDE.md`, wrapped in idempotent markers (Phase 5 uses this same convention for the global copy):
     ```
     <!-- BEGIN with-aart:agent -->
     …AGENTS.md's content, verbatim…
     <!-- END with-aart:agent -->
     ```
     **Check first, then write:** if `CLAUDE.md` already has a `<!-- BEGIN with-aart:agent -->` line, replace everything from that line through its matching `<!-- END with-aart:agent -->` line (inclusive) with the new block; if it doesn't, append the block at the end of the file. Never just append unconditionally — that duplicates the block on a re-run. Leave `AGENTS.md` itself on disk too — harmless, just unread by this host, and `init-agent` expects to keep regenerating it there.
   - **opencode:** transcribe `.mcp.json` into `opencode.json` per Phase 1's shape (carrying over the `--root` args from step 2), then delete the now-redundant `.mcp.json`. `AGENTS.md` needs no further step.
   - **Other hosts:** whichever of the two files from Phase 1 didn't already come out right, fix by hand — the mechanism is the same either way.

4. **Re-running is safe** — the documented way to refresh both files after an AART upgrade. Remember steps 2 and 3 are yours, not `init-agent`'s: a bare re-run regenerates `.mcp.json`/`AGENTS.md` fresh, which means the `--root` append and (Claude Code) the `CLAUDE.md` copy need redoing too, every time.

## Phase 5 — Install the working instructions globally (ask first)

**This is the install's highest-impact write — its own decision point, same as any change to how every session on this machine starts.**

**Decision point 3 — ask explicitly, naming this host's actual global file from Phase 1:** *"Install AART's working instructions — the verify reflex, the authoring loop — in `<global instruction file>`, so every AART-enabled project gets them without a per-project copy? This changes how every session on this machine starts."* A general "go ahead with the install" does not cover this — wait for an explicit yes.

On yes:

1. **Generate the canonical text — never hand-write or paraphrase it.** In a scratch directory that is *not* a real project:
   ```bash
   npx -y @team-monet/aart init-agent --mcp-config-out <scratch>/.mcp.json --instructions-out <scratch>/AGENTS.md
   ```
   Read `<scratch>/AGENTS.md` — its content, verbatim, is the block you install. Discard the scratch directory afterward (its `.mcp.json` means nothing outside a real workspace, and `--npx` doesn't matter for this specific invocation since only the instructions text gets used). This always comes from actually running `aart init-agent` — the same source every caller uses — never a second, hand-maintained copy anywhere in `with-aart/` or in this file.

   A scratch directory has no real trust-mode configuration, so this generates the **governed**-mode approval section (the platform default). If the user runs a different trust mode somewhere, say so: the global copy's approval section is representative, not authoritative for every project — each workspace's own `AGENTS.md`/`CLAUDE.md` (Phase 4) is the source of truth for *that* project's actual mode. The verify reflex and the authoring loop — most of the document — don't vary by mode at all.

2. **Write it into `<global instruction file>`, wrapped in the same idempotent markers:**
   ```
   <!-- BEGIN with-aart:agent -->
   …the generated AGENTS.md body…
   <!-- END with-aart:agent -->
   ```
   - **Back up first** (`<file>.bak`).
   - **Same check-first-then-write rule as Phase 4's marker step:** if the file already has a `<!-- BEGIN with-aart:agent -->` line, replace everything from that line through its matching `<!-- END with-aart:agent -->` line (inclusive); if it doesn't, append the block at the end of the file, below any other existing content. The user may already have other standing instructions there (most likely: a `with-monet` install's own lead persona, in its own `<!-- BEGIN with-monet:stig -->` markers) — AART's instructions and a with-monet lead persona coexist fine either way.
   - **File requires frontmatter** (some hosts' rule files do): keep markers and body *below* it — a leading HTML comment can break the file's own activation metadata.
   - **Show the user the exact diff before writing**, and proceed only once they've seen it.
3. **Tell the user to reload/restart the host** if it only loads global instructions at launch (Claude Code does) — otherwise the running session keeps whatever it already had until then.

## Phase 6 — Verify

Don't claim success from a write succeeding alone — confirm both halves actually work.

1. **Portable MCP handshake — no `timeout` dependency** (GNU `timeout` doesn't exist on macOS; this doesn't need it). Run from any shell:
   ```bash
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install-verify","version":"0.0.0"}}}' \
     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
   | npx -y @team-monet/aart mcp
   ```
   (If Phase 2 settled on a store path, append `--root "<the store path from Phase 2>"` to the `npx -y @team-monet/aart mcp` command — the final pipeline stage — to verify against the actual configured store.) `printf`'s own EOF once it finishes writing is what ends the server cleanly — no signal, no timeout utility needed; this works the same in zsh and bash on macOS and Linux.

   **Expect two JSON-RPC lines back, then a shutdown notice (~6 lines total):**
   - First line contains `"serverInfo":{"name":"aart"`.
   - Second line contains `"aart_find_blocks"` inside the `tools` array (one of 17 tools on a bare project in the default governed mode — the exact count varies with trust mode and what's already in the store, so treat `aart_find_blocks`'s presence as the check, not a specific total).
   - After those two, a pretty-printed `{"ok": true, "message": "MCP server stopped."}` — the clean-EOF shutdown notice firing. Its presence is positive proof the pipe closed cleanly, not an error.

   A stray `ExperimentalWarning: SQLite is an experimental feature` line on stderr is expected noise, not a failure. If there's no output at all after a few seconds (and this isn't the first-ever npx warm-up from Phase 3), something is actually wrong — check what's literally at the other end of the MCP config's `command`/`args` before assuming AART itself is broken.

2. **The host actually sees it.** Reload the host first if it only loads MCP config / global instructions at launch. Then:
   - List registered tools (Claude Code: `/mcp`, or call a tool directly) and confirm `aart` is connected and `aart_find_blocks` is offered.
   - Actually **call** `aart_find_blocks` (empty query, or something like `"http"`) and report a compact summary of what came back — a tool appearing in a list only proves registration, not that the server behind it runs.
   - If Phase 5 ran: in a *new* session, confirm the host's own context includes the `with-aart:agent` block — e.g. ask the agent to describe AART's verify reflex without being told anything first. If it can't after a reload, the write likely landed in the wrong file for this host — recheck Phase 1 rather than rewriting blindly.

## Phase 7 — Report back

Close the loop with the user in one message:

- **What got installed, and where** — exact files written (per workspace, and the global file if Phase 5 ran), the store path(s) decided in Phase 2/written in Phase 4, and the install mode (npx-only, or global and why).
- **How to undo all of it** — remove the `aart` entry from `.mcp.json`/`opencode.json` (or delete the whole file if AART was the only entry); delete this workspace's `AGENTS.md` and, on Claude Code, the `with-aart:agent` block from its `CLAUDE.md`; delete the same block from the global instruction file (restore from the `.bak` Phase 5 made, if nothing else has touched it since); `npm uninstall -g @team-monet/aart` if it was installed; delete the store directory/directories only if the user also wants that data gone — say plainly that step is destructive.
- **One suggested first action** — e.g. call `aart_find_blocks` to see what's already composable, or ask the user what they'd like to automate first.
- **One line, no pressure:** *"If this was useful: https://github.com/team-monet/aart — a star helps."*

---

## Principles

- **Agent-first:** you do the install; the user converses, approves, and steers.
- **Zero-install by default:** `npx` covers the common case end to end; global install is an opt-in convenience, never a requirement and never a reason to hardcode a binary path.
- **Never a resolved absolute path in MCP config:** always the npx form, with one deliberate, stated exception (pinning a from-source build).
- **Write only to the current host's files:** never touch another agent host's config or instruction files just because they happen to exist on the same machine.
- **Fix-forward:** on any failure, diagnose and resolve with the user rather than dumping a stack trace.
- **Permission prompts are checkpoints, not failures:** a host challenging a global-instruction-file write is expected — pause, show the user what you're about to write and why, proceed on explicit OK.
- **Non-destructive:** back up before overwriting, merge into existing config rather than replacing it, never clobber the user's own content.
- **One source of truth:** the working-instructions text always comes from actually running `aart init-agent`, never from a copy hand-maintained in this file or anywhere else in `with-aart/`.
