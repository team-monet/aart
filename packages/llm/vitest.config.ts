import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/llm",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
