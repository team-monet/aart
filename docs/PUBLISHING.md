# Publishing aart (so `npx aart` works)

The package is set up to distribute via npm. Consumers then run it with **no
clone**: `npx aart mcp` or `npm i -g aart`.

## What ships

`package.json` `files: ["dist", "examples"]` → the tarball contains only the
compiled `dist/`, the examples, and `README.md`. Source, tests, and the strategy
docs (`docs/`) are **not** published. Verify any time with:

```bash
npm pack --dry-run
```

## Settled

- **Name:** `@team-monet/aart` (the `aart` bin/command is unchanged; only the npm
  package id is scoped). `@team-monet/aart` is free on npm.
- **License:** Apache-2.0 (`LICENSE` file at the repo root; `license` in
  package.json). Public.
- `publishConfig.access: "public"` is set, so the scoped package publishes
  publicly (scoped packages default to restricted otherwise).

## Publish

Run by a member of the **@team-monet** npm org with publish rights:

```bash
npm login                 # authenticate (an account in the @team-monet org)
npm publish               # prepublishOnly runs typecheck+tests; prepare builds dist
# later releases:
npm version patch|minor   # bump, then `npm publish` again
```

`prepublishOnly` (`typecheck && test`) and `prepare` (`build`) run automatically,
so a broken build can't be published and `dist/` is always fresh in the tarball.
First publish creates `@team-monet/aart@0.1.0`.

## How consumers use it

```bash
npx @team-monet/aart --help          # the command is still `aart`
npx playwright install chromium      # only for QA *browser* blocks
```

MCP config for a coding-agent host:

```json
{ "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"],
  "env": { "AART_WORKSPACE": "/path/to/their/project" } }
```

`isolated-vm` is an **optionalDependency** + lazy-loaded, so install never fails
on a platform without a prebuilt binary; only `node`-block execution needs it
(the QA pack's native blocks don't).

## Private distribution (no public npm)

- **GitHub Packages**: scope the name to your GitHub user/org and add a
  `.npmrc` pointing `@scope` at `npm.pkg.github.com`; consumers need a token.
- **Tarball on a Release**: `npm pack` → upload the `.tgz` → consumers
  `npm i -g https://…/aart-0.1.0.tgz` (no `npx aart`, but no registry either).
- **Docker (GHCR)**: bundles Node + isolated-vm + Chromium; `docker run -i …`.
  Heaviest but zero toolchain/clone — see the distribution discussion.
