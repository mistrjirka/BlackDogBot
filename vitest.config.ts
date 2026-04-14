import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/core/**/*.test.ts",
      "tests/integration/mcp/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/defaults/**"],
    },
    testTimeout: 90000,
    hookTimeout: 600000,
  },
});
