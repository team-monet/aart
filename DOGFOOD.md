# Dogfooding the verify reflex

The goal here isn't a feature — it's an **experiment**: does Claude reach for `aa_verify`
*on its own* after a web change, the way it reaches for the test suite? Unprompted use is
the adoption metric. If it happens, the reflex took. If it doesn't, that's the signal to
sharpen the cue (`CLAUDE.md` / the `verify-with-aart` skill / the guide) or cut friction.

## One-time setup

1. **Build the loop** (on `feat/agent-verify-loop`):
   ```
   npm run build
   ```
2. **Connect the aart MCP** to Claude Code in this repo:
   ```
   claude mcp add aart -- node "$(pwd)/dist/cli/index.js" mcp
   ```
   (or add the block from `with-aart/README.md` to `.mcp.json`). Confirm with `/mcp` that
   `aart` is connected and `aa_verify` shows up in its tool list.

   The repo `CLAUDE.md` and the `with-aart/` skill are already in place to cue the reflex —
   nothing else to wire.

## A self-contained target: aart's own dashboard

```
aart dashboard --port <free-port>      # 4400/4500 may be taken on this box; pick a free one
```
Serves a JS page at `http://127.0.0.1:<port>` (tabs: Runs / Blocks / Packs).

## Run the experiment

In a **fresh** Claude Code session in this repo (aart MCP connected):

1. Make — or ask Claude to make — a change that affects the dashboard UI, e.g. edit the
   empty-state copy or a tab label in `src/cli/commands/dashboard.ts`.
2. Watch whether Claude calls
   `aa_verify({ url: "http://127.0.0.1:<port>", expect: "<the new text>" })`
   to confirm it actually rendered — **without being told to**.

Reaching for it unprompted = success.

## What a healthy result looks like

`aa_verify` returns a compact verdict — `title`, rendered `text`, interactive `elements`,
`consoleErrors`, a `screenshot` path, and `ok` (if you passed `expect`) — small enough to
read at a glance, with the full text + screenshot offloaded to run artifacts.

Proven on this machine: `web.read` against the live dashboard returns
`{ title: "aart dashboard", elements: [Runs, Blocks, Packs], consoleErrors: { count: 0 },
settled: true }` in ~590ms, no approval gate, no `--yes`.
