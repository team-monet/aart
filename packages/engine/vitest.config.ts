import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/engine",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The wait/resume machine's E2E fixtures (a "process restart" simulated by
    // discarding in-memory objects and reloading fresh from an fs-backed
    // store) and the isolated-vm sandbox's escape-attempt tests are
    // genuinely slower than the rest of this package's unit tests — default
    // vitest timeouts are fine for those, but the sandbox spins up real V8
    // isolates, which is slower under CI/sandboxed CPU throttling than local
    // dev; a slightly higher test timeout avoids flaking on that alone.
    testTimeout: 15_000,
  },
});
