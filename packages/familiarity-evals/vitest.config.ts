import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/familiarity-evals",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
