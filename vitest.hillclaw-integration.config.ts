import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/hillclaw/test-suites/integration/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
