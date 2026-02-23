import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 600000,    // 10 minutes
    hookTimeout: 600000,    // 10 minutes
    env: {
      BETTERCLAW_MODELS_DIR: path.join(os.homedir(), ".betterclaw", "models"),
    },
  },
});
