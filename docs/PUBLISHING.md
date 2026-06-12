# Publishing @team-monet/aart

The package is **live on npm** as `@team-monet/aart` (0.6.0 shipped; 0.7.0 in
progress). Consumers run it with no clone: `npx @team-monet/aart mcp` or
`npm i -g @team-monet/aart`.

## What ships

`package.json` `files: ["dist", "examples"]` — the tarball contains only the
compiled `dist/`, the `examples/`, and `README.md`. Source, tests, and strategy
docs (`docs/`) are **not published**. Verify any time with:

```bash
npm pack --dry-run
```

## Publish automation

Publishing is **fully automated** via `.github/workflows/publish.yml`, triggered
by publishing a GitHub Release. There is **no `NPM_TOKEN` secret** — the workflow
authenticates via **npm Trusted Publishing (OIDC)**, using the GitHub Actions
OIDC provider to prove the publish came from this repository and workflow.

### One-time npmjs.com Trusted Publisher setup

In the `@team-monet/aart` npm package settings:

1. Go to **Settings → Trusted Publishers → Add a publisher**.
2. Set:
   - **Organization:** `team-monet`
   - **Repository:** `aart`
   - **Workflow filename:** `publish.yml`
3. Save. No token is created or stored anywhere.

The workflow uses `permissions: id-token: write` to request an OIDC token from
GitHub, which npm exchanges for publish access. This requires **npm ≥ 11.5.1**;
the workflow upgrades npm automatically before publishing.

### Release flow

1. **Bump the version** in all three places (per AGENTS.md):
   - `package.json` → `"version"`
   - `src/cli/index.ts` → `.version('X.Y.Z')`
   - `src/mcp/server.ts` → version string
2. Run `npm i --package-lock-only` to update the lockfile without installing.
3. Merge to **main**.
4. On GitHub: **Releases → Draft a new release**.
   - Tag: `vX.Y.Z` (must match the package.json version).
   - Fill in the release notes, then click **Publish release**.
5. The `publish.yml` workflow fires automatically and publishes to npm.

### What `npm publish` runs automatically

`prepublishOnly` runs `npm run typecheck && npm test` — this is the full
Chromium test suite (browser blocks drive real Playwright). A broken build or
any test failure aborts the publish. `prepare` runs `npm run build` to ensure
`dist/` is always freshly compiled in the tarball.

## How consumers use it

```bash
npx @team-monet/aart --help          # the command is still `aart`
npx playwright install chromium      # only for browser.* blocks
```

MCP config for a coding-agent host:

```json
{ "command": "npx", "args": ["-y", "@team-monet/aart", "mcp"],
  "env": { "AART_WORKSPACE": "/path/to/their/project" } }
```

`isolated-vm` is an **optionalDependency** + lazy-loaded, so `npm install`
never fails on a platform without a prebuilt binary. Only `node`-block execution
needs it; the core pack's browser/http/assert blocks do not.

## Private distribution (no public npm)

- **GitHub Packages**: scope the name to your GitHub org and add a `.npmrc`
  pointing `@scope` at `npm.pkg.github.com`; consumers need a token.
- **Tarball on a Release**: `npm pack` → upload the `.tgz` → consumers
  `npm i -g https://…/aart-0.7.0.tgz` (no `npx aart`, but no registry).
- **Docker (GHCR)**: bundles Node + isolated-vm + Chromium; `docker run -i …`.
  Heaviest but zero toolchain/clone.
