import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 3000000,   // 50 minutes
    hookTimeout: 3000000,   // 50 minutes
    env: {
      BLACKDOGBOT_MODELS_DIR: path.join(os.homedir(), ".blackdogbot", "models"),
    },
  },
});
