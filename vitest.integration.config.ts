import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 600000,    // 10 minutes
    hookTimeout: 600000,    // 10 minutes
  },
});
