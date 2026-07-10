import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@aart/evidence",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
