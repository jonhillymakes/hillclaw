import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/hillclaw/test-suites/unit/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
