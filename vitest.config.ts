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
    // Keep the standard Vitest excludes, and carve out the heavy model-in-the-loop
    // e2e probe (30-min, local 9B) so the default suite stays fast. Run it on demand
    // via `pnpm test:integration` / `test:build` (vitest.integration.config.ts).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "tests/integration/core/variable-store.e2e.test.ts",
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
