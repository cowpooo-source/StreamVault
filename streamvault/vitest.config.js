import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.js"],
    css: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      exclude: ["e2e/**", "dist/**", "**/*.test.js", "**/*.test.jsx", "tests/setup.js"],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 45,
        statements: 50,
      },
    },
  },
});