# with-aart

**Agent-first onboarding for [AART](../README.md)** — wires a coding agent's MCP config to a workspace's `.aart` store and installs AART's working instructions so the agent reaches for them the way it reaches for the test suite.

AART doesn't call an LLM on your behalf. **You** (the calling agent) author the workflow; AART validates it, governs it, runs it deterministically, and hands back an evidence report you can trust. The capability is necessary but not sufficient — a tool that's merely *available* gets ignored. What earns adoption is (1) almost no friction, (2) a cue at the right moment, and (3) a payoff the agent feels. `with-aart` supplies (2) and (3); AART's own approval-off-by-default `dev`/`governed` modes supply (1).

## Where this sits

`with-aart` lives **inside** the `aart` repo (unlike some substrate-plus-harness setups that split those across two repos) — AART is still pre-`1.0.0`, and the harness and the runtime it wires up aren't independently versioned yet. Once AART reaches `1.0.0` this may get its own release cadence; for now, cloning `aart` gets you both.

## What it installs

1. **The AART MCP server, wired per workspace** (`aart init-agent`, invoked for you) — `aart_find_blocks`, `aart_verify`, `aart_register_block`, `aart_validate`, `aart_run_workflow`, `aart_get_report`, and more (16 tools on a bare-fresh project, up to 21 once the workspace has a registered `Environment`/`EvalSuite`). This step is **per workspace** by design — AART's store is workspace-scoped, like `.git`, so there's no single "install once for every project" step for the MCP wiring itself.
2. **AART's working instructions, installed once per host** — the verify reflex, why to reach for a governed workflow instead of a one-off script, the authoring loop (discover → draft → register → validate → run → report), `{{ }}` expression wiring, and approval semantics. Installed into your coding agent's global, always-on instruction surface (e.g. Claude Code's user-level `CLAUDE.md`) so every AART-enabled project gets the reflex without a fresh copy each time — the one piece of this bootstrap that mirrors a "install the team once, globally" pattern, adapted to AART's single-agent-with-tools model rather than a multi-agent team.

Both pieces of generated content — the per-workspace `AGENTS.md` and the global instructions block — come from the exact same place: `aart init-agent`'s own generator (`packages/mcp/src/init-agent.ts`). Nothing in `with-aart/` hand-duplicates that prose.

## Install (agent-first — paste one line into your agent)

You don't clone this repo separately or run a script by hand. Open the coding agent you already use and paste **one line**; the agent installs and configures AART *for* you — detecting your host, wiring this workspace's MCP config, offering to install the working instructions globally, then verifying both. It diagnoses and fixes failures interactively.

Paste into your agent:

> **Set up AART for me: read https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md and follow it, checking with me at each decision point.**

_(Repo already cloned locally? Point at `with-aart/bootstrap/install.md` instead of the URL.)_

**Already installed?** To refresh your AART installation to the latest working instructions, paste:

> **Can you update my AART installation following https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md?**

The agent then follows the [bootstrap playbook](bootstrap/install.md): **orient → get AART → wire this workspace's MCP config → offer the global working-instructions install → verify.** Why agent-first: the agent already has tools in your environment, so it can install, verify, and recover from failures conversationally.

**One honest difference from a fully-published harness:** AART is pre-`1.0.0`, so Phase 2 of the playbook installs from source (`git clone` + build) rather than a one-line `npm i -g` — see [`AUTHORING.md`](../AUTHORING.md) part (b) for exactly why `npm i -g @team-monet/aart` isn't safe to run yet. Once `1.0.0` ships, that phase collapses to the single-line form.

## Founder / developer reference

Setting up a machine to author AART workflows and ship them to a running server, by hand rather than via the agent-first flow above? See [`AUTHORING.md`](../AUTHORING.md) — `with-aart`'s Phase 2/3 defer to its part (b)/(c) for the exact commands rather than re-deriving them here, so that stays the one canonical place they're written down.

> ⭐ **Like AART? [Star this repo](https://github.com/team-monet/aart)** to support it.
