import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["test/**"],
    testTimeout: 15000,
    setupFiles: ["tests/setup.js"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      exclude: ["tests/setup.js"],
      thresholds: {
        lines: 42,
        functions: 32,
        branches: 30,
        statements: 42,
      },
    },
  },
});