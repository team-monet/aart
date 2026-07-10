import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/blocks-core",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Browser/command-spawn tests shell out to a real headless Chromium /
    // child process — give them more room than the default 5s, matching
    // the spirit of S0's own platform smoke tests (Playwright can be slow
    // to launch cold in a CI sandbox).
    testTimeout: 20_000,
  },
});
