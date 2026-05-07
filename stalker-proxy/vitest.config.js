import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["test/**"],
    testTimeout: 15000,
    setupFiles: ["tests/setup.js"],
  },
});
