# with-aart — give your coding agent eyes

`aart` lets an agent **perceive and verify the real world** — rendered pages, running services — and get back a compact, context‑sized answer instead of guessing from code. This bootstrap makes the agent reach for it **reflexively**, the way it reaches for the test suite.

The capability is necessary but not sufficient: a tool that is merely *available* gets ignored. What earns adoption is (1) almost no friction, (2) a cue at the right moment, and (3) a payoff the agent feels. This bootstrap supplies (2) and (3); aart's approval‑off‑by‑default default supplies (1).

## What it installs

1. **The aart MCP server** — the tools: `aa_verify`, `aa_find_blocks`, `aa_run_workflow`, `aa_get_report`, …
2. **A skill** (`verify-with-aart`) — cues the agent to verify after a runtime/UI change.
3. **A CLAUDE.md snippet** — makes the verify reflex a project norm.

## Install (Claude Code)

1. **Connect the MCP server** — point it at your aart build (or `npx @team-monet/aart`):

   ```
   claude mcp add aart --env AART_WORKSPACE=/absolute/path/to/your/project -- aart mcp
   ```

   or add the block below to your MCP config.

2. **Add the skill** — copy `skills/verify-with-aart/` into your project's `.claude/skills/`.

3. **Add the reflex to CLAUDE.md** — append `project-CLAUDE.md` to your project's `CLAUDE.md`.

## MCP config block

```json
{
  "mcpServers": {
    "aart": {
      "command": "aart",
      "args": ["mcp"],
      "env": { "AART_WORKSPACE": "/absolute/path/to/your/project" }
    }
  }
}
```

If `aart` isn't on your PATH, point at the built CLI directly:

```json
{ "command": "node", "args": ["/path/to/aa-runtime/dist/cli/index.js", "mcp"] }
```

## The one habit this builds

> After a change that affects a **page or a service**, call **`aa_verify`** to *see* whether it actually works — before claiming done.

That's it. `aa_verify` returns a context‑sized verdict (title, rendered text, interactive elements, console errors, a screenshot, `ok`), so the habit is cheap; approval is off by default, so there's no gate between authoring and running. Success looks like the agent reaching for it **on its own**, not when told.
