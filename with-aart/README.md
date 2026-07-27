# with-aart

**Agent-first onboarding for [AART](../README.md)** — wires a coding agent's MCP config to a workspace's `.aart` store and installs AART's working instructions so the agent reaches for them the way it reaches for the test suite.

AART doesn't call an LLM on your behalf. **You** (the calling agent) author the workflow; AART validates it, governs it, runs it deterministically, and hands back an evidence report you can trust. The capability is necessary but not sufficient — a tool that's merely *available* gets ignored. What earns adoption is (1) almost no friction, (2) a cue at the right moment, and (3) a payoff the agent feels. `with-aart` supplies (2) and (3); AART's own approval-off-by-default `dev`/`governed` modes supply (1).

## Where this sits

`with-aart` lives **inside** the `aart` repo (unlike some substrate-plus-harness setups that split those across two repos) — AART is still pre-`1.0.0`, and the harness and the runtime it wires up aren't independently versioned yet. Once AART reaches `1.0.0` this may get its own release cadence; for now, cloning `aart` gets you both.

## What it installs

1. **The AART MCP server, wired per workspace** (`aart init-agent`, invoked for you) — including reuse-first `aart_find_workflows`, `aart_find_blocks`, and `aart_find_packs`, plus Pack install/list/human-approval, verification, registration, validation, execution, and evidence tools. The generated command pins the chosen store's absolute path, so multiple workspaces can deliberately share one reusable-asset registry or remain isolated.
2. **AART's working instructions, installed once per host** — the verify reflex and the reuse-first loop (search workflows → search blocks → adapt or draft → validate → run → report → approve/share), plus `{{ }}` expression wiring and approval semantics. Installed into your coding agent's global, always-on instruction surface so every AART-enabled project gets the same reflex.

Both pieces of generated content — the per-workspace `AGENTS.md` and the global instructions block — come from the exact same place: `aart init-agent`'s own generator (`packages/mcp/src/init-agent.ts`). Nothing in `with-aart/` hand-duplicates that prose.

## Install (agent-first — paste one line into your agent)

You don't clone this repo separately or run a script by hand. Open the coding agent you already use and paste **one line**; the agent installs and configures AART *for* you — detecting your host, wiring this workspace's MCP config, offering to install the working instructions globally, then verifying both. It diagnoses and fixes failures interactively.

Paste into your agent:

> **Set up AART for me: read https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md and follow it, checking with me at each decision point.**

_(Repo already cloned locally? Point at `with-aart/bootstrap/install.md` instead of the URL.)_

**Already installed?** To refresh your AART installation to the latest working instructions, paste:

> **Can you update my AART installation following https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md?**

The agent then follows the [bootstrap playbook](bootstrap/install.md): **orient → get AART → wire this workspace's MCP config → offer the global working-instructions install → verify.** Why agent-first: the agent already has tools in your environment, so it can install, verify, and recover from failures conversationally.

**Phase 3 of the playbook gets AART — npx-first, zero install by default** (`npx -y @team-monet/aart <cmd>`), correct as of `0.10.0`; global `npm install -g @team-monet/aart` is opt-in, for CLI convenience only — see [`AUTHORING.md`](../AUTHORING.md) part (b) for the version-pin note (older `0.1.0`–`0.9.0` releases under this same package name are a different, superseded CLI) and the from-source alternative for contributors.

## Founder / developer reference

Setting up a machine to author AART workflows and ship them to a running server, by hand rather than via the agent-first flow above? See [`AUTHORING.md`](../AUTHORING.md) — `with-aart`'s Phase 3/4 defer to its part (b)/(c) for the exact commands rather than re-deriving them here, so that stays the one canonical place they're written down.

> ⭐ **Like AART? [Star this repo](https://github.com/team-monet/aart)** to support it.
