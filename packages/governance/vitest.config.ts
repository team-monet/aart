import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/governance",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
