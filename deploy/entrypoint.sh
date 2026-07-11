#!/bin/sh
# entrypoint.sh — the Docker image's command dispatcher (AMENDMENTS.md A49).
#
# `docker run <image> server ...` / `worker ...` / `mcp ...` / `run ...` /
# `register ...` / any other real `aart` subcommand — dispatches straight to
# the bundled CLI (packages/cli/dist/bin.js, built by `pnpm --filter
# @team-monet/aart run build:publish`), unmodified: whatever `aart --help`
# documents as a real command works here identically, since this IS that
# same binary, just invoked via `node` instead of the `aart` bin shim
# (equivalent — package.json's own "bin": {"aart": "./dist/bin.js"} points
# at the exact same file).
#
# `docker run <image> dashboard ...` — there is no literal `aart dashboard`
# CLI subcommand (`@aart/dashboard` is a private, workspace-only package,
# never bundled into the CLI — see DEPLOY.md's "What's NOT in this image"
# section for why). This is the "-equivalent" the task brief asks for:
# deploy/serve-dashboard.mjs is this deploy kit's own thin composition-root
# wrapper around @aart/dashboard's real, documented `startDashboard` API
# (packages/dashboard/src/index.ts's own header comment), esbuild-bundled
# at image build time (deploy/build-dashboard-launcher.mjs) into
# packages/cli/dist/serve-dashboard.mjs (yes, alongside the CLI's own
# bin.js/index.js bundles — see that build script's header comment for
# why: it needs the SAME already-correctly-linked node_modules the CLI
# bundle's own EXTERNAL packages resolve through).
set -e

if [ "$1" = "dashboard" ]; then
  shift
  exec node /app/packages/cli/dist/serve-dashboard.mjs "$@"
fi

exec node /app/packages/cli/dist/bin.js "$@"
