import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/mcp",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
