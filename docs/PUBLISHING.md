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

## Before the first publish — decide three things

1. **Name.** `aart` may be taken on npm. If so, scope it: set `"name":
   "@yourname/aart"` (the `publishConfig.access: "public"` is already set so a
   scoped package publishes publicly).
2. **License.** Currently `"UNLICENSED"` (proprietary). For a public package set
   a real license (e.g. `"MIT"`) or keep it private (see below).
3. **Public vs private.** Public npm = anyone can `npx aart`. For private
   distribution instead, see the bottom of this doc.

## Publish

```bash
npm login                 # once, with the account that owns the name
npm version patch|minor   # bump (or edit "version" by hand)
npm publish               # prepublishOnly runs typecheck+tests; prepare builds dist
```

`prepublishOnly` (`typecheck && test`) and `prepare` (`build`) run automatically,
so a broken build can't be published and `dist/` is always fresh in the tarball.

## How consumers use it

```bash
npx aart --help
npx playwright install chromium   # only for QA *browser* blocks
```

MCP config for a coding-agent host:

```json
{ "command": "npx", "args": ["-y", "aart", "mcp"],
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
