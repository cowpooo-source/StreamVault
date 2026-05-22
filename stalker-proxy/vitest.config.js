import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["test/**"],
    testTimeout: 15000,
    setupFiles: ["tests/setup.js"],
  },
  coverage: {
    provider: "v8",
    reportsDirectory: "./coverage",
    exclude: ["tests/setup.js"],
    thresholds: {
      lines: 70,
      functions: 70,
      branches: 60,
      statements: 70,
    },
  },
});
