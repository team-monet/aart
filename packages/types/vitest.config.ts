import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/types",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
