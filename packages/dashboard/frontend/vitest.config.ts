import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Mirrors packages/dashboard/vitest.config.ts's own minimal per-package
// convention (name + include + environment). `environment: "jsdom"` (not
// "node", unlike every other package's vitest config in this workspace) is
// the one deliberate divergence — this is the first package in the
// workspace whose tests render actual DOM (@testing-library/react), so it
// needs jsdom's document/window globals; every other package's tests are
// pure Node.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./@"),
    },
  },
  test: {
    name: "@aart/dashboard-frontend",
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
