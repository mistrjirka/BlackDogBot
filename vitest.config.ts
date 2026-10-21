import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

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
      // Real-provider / model-in-the-loop tests are on-demand only:
      // `pnpm test:integration` (vitest.integration.config.ts) runs them.
      "tests/integration/core/**/*e2e.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/defaults/**"],
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      BLACKDOGBOT_MODELS_DIR: path.join(os.homedir(), ".blackdogbot", "models"),
    },
  },
});
