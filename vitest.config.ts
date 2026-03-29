import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/core/**/*.test.ts",
      "tests/integration/mcp/**/*.test.ts",
      "tests/integration/tools/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/defaults/**"],
    },
    testTimeout: 90000,
  },
});
