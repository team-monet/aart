// Vitest 4 removed the old `defineWorkspace`/`vitest.workspace.ts`
// auto-discovery mechanism and the `--workspace` CLI flag (verified against
// the installed vitest@4.1.10: `defineWorkspace` is no longer exported;
// `projects` is now a `test` config field on a normal Vitest config,
// resolved via `TestProjectConfiguration[]`). This file keeps the
// `vitest.workspace.ts` name and role the task brief calls for — it is the
// one place the set of test projects is declared — but is wired in via
// `vitest run --config vitest.workspace.ts` (see package.json's `test`
// script) rather than filename-based auto-discovery, since that no longer
// exists in this Vitest version.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "packages/*/vitest.config.ts" only reaches direct children of
    // packages/ — packages/dashboard/frontend's own vitest.config.ts is
    // one level deeper (it's a nested workspace member, pnpm-workspace.yaml
    // "packages/dashboard/frontend"), so it needs its own explicit entry
    // or `pnpm run test` silently never runs the SPA's tests at all.
    projects: ["packages/*/vitest.config.ts", "packages/dashboard/frontend/vitest.config.ts"],
  },
});
