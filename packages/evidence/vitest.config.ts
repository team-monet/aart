import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Production resolves this public subpath to @aart/engine/dist after the
    // workspace build. Source-level package tests run before dist exists, so
    // point the same entry point at its source without falling back to the
    // sandbox-bearing @aart/engine root.
    alias: {
      "@aart/engine/workflow-output-contract": fileURLToPath(
        new URL("../engine/src/workflow-output-contract.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "@aart/evidence",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
