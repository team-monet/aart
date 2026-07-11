# syntax=docker/dockerfile:1
#
# AART production image (AMENDMENTS.md A49). Multi-stage; the bundled CLI
# (packages/cli/dist/bin.js, `pnpm --filter @team-monet/aart run
# build:publish`) is the entrypoint surface — `server`/`worker`/every other
# real `aart` subcommand dispatch straight to it, plus a `dashboard`
# "-equivalent" command (deploy/serve-dashboard.mjs — @aart/dashboard is
# never bundled into the CLI, see DEPLOY.md).
#
# Targets (this file's LAST stage, `runtime`, is the default — no --target
# needed for the common case):
#   runtime          lean: server/worker/dashboard/mcp, no browser automation.
#                     browser.* workflow steps fail at dispatch (no Chromium
#                     installed) — this is the default `docker build` output.
#   runtime-browser   runtime + Playwright's Chromium and its OS-level deps,
#                     for workflows using browser.* blocks. Meaningfully
#                     larger (Chromium alone is ~300-400MB) — opt in with
#                     --target, never the accidental default.
#   test              NOT shipped anywhere — the full gate suite + this
#                     repo's platform smoke tests (isolated-vm, Playwright),
#                     run for real on Linux. This is this session's own
#                     Linux verification proof (AMENDMENTS.md A49); build it
#                     explicitly to reproduce:
#                       docker build --target test -t aart:test .
#
# Build:
#   docker build -t aart:latest .                            # lean (default)
#   docker build --target runtime-browser -t aart:browser .   # + Chromium
#   docker build --target test -t aart:test .                 # gate suite + smoke, Linux
#
# Run (see docker-compose.yml for the multi-service shape, DEPLOY.md for the
# full operational story — secrets, backup/restore, upgrades, ops limits):
#   docker run --rm -p 8080:8080 -v aart-data:/data aart:latest server --store sqlite
#   docker run --rm -v aart-data:/data aart:latest worker --store sqlite
#   docker run --rm -p 4000:4000 -v aart-data:/data aart:latest dashboard
#   docker run --rm -v aart-data:/data aart:latest register /path/to/workflow.yaml

# =============================================================================
# base — shared by every stage below: pnpm via corepack (package.json pins
# "packageManager": "pnpm@10.33.2", the same version this repo's own gates
# have always run under — corepack reads and honors that pin exactly, not a
# separately-chosen version).
# =============================================================================
FROM node:22-bookworm-slim AS base
# Debian/glibc, not Alpine: isolated-vm ships prebuilt native binaries only
# for glibc targets (node_modules/isolated-vm/prebuilds/linux-{x64,arm64},
# verified by inspection before choosing this base rather than assumed —
# see AMENDMENTS.md A49), and Playwright's own Chromium distribution and
# `install --with-deps` apt-based dependency installer both assume a
# Debian/Ubuntu-family base — this matches isolated-vm's OWN reference
# Dockerfile.debian's base image choice (node_modules/isolated-vm/
# Dockerfile.debian, shipped with the package itself), not a guess.
RUN corepack enable

# =============================================================================
# builder — full workspace install + build + bundle. Never shipped; only
# specific outputs are copied out of it below.
# =============================================================================
FROM base AS builder
WORKDIR /workspace
# g++/make/python3: the FALLBACK path for isolated-vm's own install script
# ("node-gyp-build || node-gyp rebuild", node_modules/isolated-vm/
# package.json) when no prebuilt binary matches the current platform.
# Verified NOT needed for our actual targets (linux-x64/linux-arm64 both
# ship a prebuild in the isolated-vm package itself) — included anyway so a
# future isolated-vm version, or a platform without a prebuild, degrades to
# "slower build" rather than a silent, confusing install failure.
RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

# Whole-workspace copy, not a package.json-first layer-cached split: this is
# a 14-package pnpm workspace using the workspace:* protocol — every
# package.json needs to be present simultaneously for `pnpm install` to
# resolve the graph correctly, and getting a partial COPY list wrong here
# (e.g. forgetting a package added later) fails silently expensive to
# debug. Correctness over incremental-rebuild speed; see DEPLOY.md's build
# notes for the CI-oriented alternative if that tradeoff ever matters.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm --filter @team-monet/aart run build:publish
# deploy/serve-dashboard.mjs (the `aart dashboard`-equivalent, see
# entrypoint.sh) needs the SAME esbuild-bundle treatment as the CLI, for
# the same two reasons build-dashboard-launcher.mjs's own header comment
# documents (pnpm's non-hoisted node_modules layout; @aart/store's barrel
# accidentally pulling in a vitest-dependent codepath if not tree-shaken).
RUN pnpm run build:dashboard-launcher

# =============================================================================
# test — the from-clean gate suite + this repo's platform smoke tests,
# genuinely run on Linux (node:22-bookworm-slim/glibc/arm64|amd64) for the
# first time (AMENDMENTS.md A49) — NOT part of the default build, NOT
# copied into any runtime stage below. Reproduce with:
#   docker build --target test -t aart:test .
# =============================================================================
FROM builder AS test
RUN npx playwright install --with-deps chromium
RUN pnpm run smoke
RUN pnpm run clean \
    && pnpm run check:tsconfig-refs \
    && pnpm run build \
    && pnpm run typecheck \
    && pnpm run typecheck:tests \
    && pnpm run lint:redaction \
    && pnpm run test

# =============================================================================
# pruned — builder's output, devDependencies removed (typescript/vitest/
# esbuild/@changesets/cli and each package's own dev-only @aart/* type
# deps — none needed once dist/ already exists). `pnpm prune`, not a fresh
# `--prod` reinstall, so this is guaranteed to be exactly builder's already-
# verified dependency resolution with dev-only entries subtracted, never a
# second, potentially-divergent resolution.
# =============================================================================
FROM builder AS pruned
# `pnpm prune --prod` (tried first) over-pruned in this workspace — it
# removed every top-level node_modules/<pkg> symlink entirely, including
# ones packages/cli's OWN "dependencies" (isolated-vm, playwright, zod, ...)
# and packages/dashboard's OWN "dependencies" (@aart/blocks-core, @aart/
# governance, ...) genuinely need at runtime, verified by inspection (`ls
# node_modules` came back nearly empty — only `.pnpm` itself survived, no
# top-level resolution entries at all). A second `--frozen-lockfile --prod`
# install, run from the SAME already-resolved lockfile builder already
# verified builds/tests clean against, does the workspace-aware thing
# correctly instead: every package's "dependencies" (root+per-package,
# unioned) stay; every devDependency-only package (typescript/vitest/
# esbuild/@changesets/cli, and each package's own dev-only @aart/* type
# deps) is removed. CI=true: pnpm's interactive "remove node_modules
# content, are you sure" confirmation has no TTY to answer it in a Docker
# build — pnpm's own documented non-interactive escape hatch.
RUN CI=true pnpm install --frozen-lockfile --prod

# =============================================================================
# runtime-base — shared by both shippable targets below: the pruned,
# already-built workspace, a non-root user, and the entrypoint dispatch
# (deploy/entrypoint.sh). `runtime`/`runtime-browser` differ ONLY in
# whether Chromium is installed on top of this.
# =============================================================================
FROM base AS runtime-base
# curl: HEALTHCHECK only (docker-compose.yml's own per-service healthchecks
# curl each role's real /health endpoint — see that file). Everything else
# this stage needs is already inside `pruned`'s node_modules.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=pruned /workspace /app
RUN chmod +x /app/deploy/entrypoint.sh \
    && mkdir -p /data \
    && chown -R node:node /data /app
# AART_ROOT (honored by every `aart` command uniformly, cli.ts's own
# resolveCliContext — "flag > env > default") points every role at the
# SAME store location by default; docker-compose.yml mounts one shared
# volume here across server/worker/dashboard, matching the task brief's
# "sharing a store volume." Override per-container with -e AART_ROOT=...
# or `--root <dir>` if you need a different layout.
ENV AART_ROOT=/data
# @aart/dashboard's own `getFrontendDir()` guesses the SPA build's location
# relative to wherever its OWN compiled code is physically running from —
# correct when that package loads unbundled, wrong once esbuild bundles it
# into packages/cli/dist/serve-dashboard.mjs (this stage's `dashboard`
# role, deploy/build-dashboard-launcher.mjs), which is a different
# directory. This is the one absolute path that's actually correct for
# THIS image's fixed layout (COPY --from=pruned /workspace /app above
# preserves the workspace's own packages/dashboard/dist/frontend
# structure) — verified directly (a real `docker run <image> dashboard`
# served the real SPA, not a 404, only once this was added).
ENV AART_DASHBOARD_FRONTEND_DIR=/app/packages/dashboard/dist/frontend
# Server control-plane (8080), worker health (8787), dashboard (4000) —
# see DEPLOY.md for exactly what each serves. A worker/dashboard-only
# container simply never binds the ports it doesn't use; EXPOSE is
# documentation, not an enforced restriction.
EXPOSE 8080 8787 4000
USER node
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
# No default role: an image that silently started `server` (or any other
# specific role) when a caller forgot to specify one would be a worse
# surprise than printing usage and exiting 1 — the bundled CLI's own
# argv.length===0 behavior (packages/cli/src/bin.ts), unchanged here.
CMD []

# =============================================================================
# runtime-browser — runtime-base + Playwright's Chromium and its real OS-
# level dependencies (`playwright install --with-deps`, not just the browser
# binary — Chromium needs actual shared libraries this minimal base doesn't
# carry). Explicit --target only; never the accidental default, and never
# folded into runtime-base itself, so a `docker build .` with no --target
# stays lean by construction, not by discipline.
# =============================================================================
FROM runtime-base AS runtime-browser
USER root
# A fixed, world-readable install path (not the default ~/.cache/ms-
# playwright) — `playwright install` below runs as root, but the actual
# process later runs as the unprivileged `node` user (USER node at the end
# of this stage); a per-user default cache dir would put the browser
# somewhere the `node` user's own $HOME can't see. Set BEFORE install so
# the same path is used at both install-time and run-time.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && npx playwright install --with-deps chromium \
    && chown -R node:node "$PLAYWRIGHT_BROWSERS_PATH"
USER node

# =============================================================================
# runtime — the lean, DEFAULT target (last stage in this file — `docker
# build .` with no --target lands here). Nothing to add beyond runtime-base;
# this stage exists so the file's final stage is the lean one, not the
# browser-enabled one.
# =============================================================================
FROM runtime-base AS runtime
