import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { vi } from "vitest";

/**
 * Write only synthetic values. No installed config, credentials, model downloads,
 * messaging adapters, or host-specific directories are required.
 */
export async function writeTestConfigAsync(
  configPath: string,
  options: { schedulerEnabled?: boolean } = {},
): Promise<void> {
  const dataDir = path.dirname(configPath);
  const config = {
    ai: {
      provider: "openai-compatible",
      compactionThreshold: 0.90,
      openaiCompatible: {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-only-not-a-secret",
        model: "test-model",
        contextWindow: 128_000,
        supportsStructuredOutputs: true,
        rateLimits: { rpm: 120, tpm: 200_000, maxConcurrent: 1 },
      },
    },
    scheduler: { enabled: options.schedulerEnabled ?? false, timezone: "UTC" },
    knowledge: { lancedbPath: path.join(dataDir, "knowledge", "lancedb") },
    skills: { directories: [], autoSetup: false, autoSetupNotify: false },
    logging: { level: "error" },
    brainInterface: { jwtSecret: "test-only-not-a-secret" },
  };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(configPath, stringifyYaml(config), { mode: 0o600 });
}

export function restoreTestDataDir(previous: string | undefined): void {
  vi.stubEnv("BLACKDOGBOT_DATA_DIR", previous);
}
