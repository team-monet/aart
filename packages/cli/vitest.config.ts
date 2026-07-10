import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@team-monet/aart",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
