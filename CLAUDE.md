# Working on aart

Build / test / version / release: see **AGENTS.md** (the canonical dev guide).

## Verify runtime changes — dogfood the product

aart's whole pitch is that an agent should **see whether a change actually works**, not guess from the code. We hold ourselves to that here first.

aart ships its own web surface — the local **dashboard** (`aart dashboard`, `src/cli/commands/dashboard.ts`). When you change anything that affects how the dashboard renders (or any page/service), verify it with aart's own **`aa_verify`** before claiming it works:

```
aa_verify({ url: "http://localhost:<port>", expect: "<text you expect to render>" })
```

- `ok: true` and `consoleErrors.count === 0` → it renders; you can claim done.
- otherwise → open the `screenshot` artifact, read the `text`, fix, re‑verify.

Reach for it the way you reach for the test suite — as part of finishing, not when asked. (Requires the aart MCP connected; approval is off by default, so there's no gate. The reusable version of this reflex for other projects lives in `with-aart/`.)
