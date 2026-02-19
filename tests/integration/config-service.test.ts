import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../src/services/config.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-cfg-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

async function writeConfigAsync(configPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, "utf-8");
}

//#endregion Helpers

//#region Tests

describe("ConfigService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    (ConfigService as unknown as { _instance: null })._instance = null;
  });

  afterEach(async () => {
    (ConfigService as unknown as { _instance: null })._instance = null;
    await cleanupTempHomeAsync();
  });

  it("should load a valid config from YAML", async () => {
    const configPath: string = path.join(tempDir, ".betterclaw", "config.yaml");

    const yaml: string = `
ai:
  provider: openrouter
  openrouter:
    apiKey: test-key-123
    model: gpt-4
    rateLimits:
      rpm: 60
      tpm: 100000
scheduler:
  enabled: false
knowledge:
  embeddingModelPath: Xenova/bge-m3
  lancedbPath: ./lancedb
skills:
  directories: []
logging:
  level: info
`;

    await writeConfigAsync(configPath, yaml);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const config = service.getConfig();

    expect(config.ai.provider).toBe("openrouter");
    expect(config.ai.openrouter?.apiKey).toBe("test-key-123");
    expect(config.scheduler.enabled).toBe(false);
    expect(config.logging.level).toBe("info");
  });

  it("should throw when config file does not exist", async () => {
    const service: ConfigService = ConfigService.getInstance();
    const fakePath: string = path.join(tempDir, "nonexistent.yaml");

    await expect(service.initializeAsync(fakePath)).rejects.toThrow("Config file not found");
  });

  it("should throw on invalid YAML config", async () => {
    const configPath: string = path.join(tempDir, "bad-config.yaml");

    await writeConfigAsync(configPath, "ai:\n  provider: invalid-provider-xyz\n");

    const service: ConfigService = ConfigService.getInstance();

    await expect(service.initializeAsync(configPath)).rejects.toThrow();
  });

  it("should return telegram config when present", async () => {
    const configPath: string = path.join(tempDir, ".betterclaw", "config.yaml");

    const yaml: string = `
ai:
  provider: openrouter
  openrouter:
    apiKey: test-key
    model: gpt-4
    rateLimits:
      rpm: 60
      tpm: 100000
telegram:
  botToken: "123456:ABC-DEF"
scheduler:
  enabled: true
knowledge:
  embeddingModelPath: Xenova/bge-m3
  lancedbPath: ./lancedb
skills:
  directories: []
logging:
  level: debug
`;

    await writeConfigAsync(configPath, yaml);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const telegramConfig = service.getTelegramConfig();

    expect(telegramConfig).toBeDefined();
    expect(telegramConfig!.botToken).toBe("123456:ABC-DEF");
  });

  it("should return undefined for telegram when not configured", async () => {
    const configPath: string = path.join(tempDir, ".betterclaw", "config.yaml");

    const yaml: string = `
ai:
  provider: openrouter
  openrouter:
    apiKey: test-key
    model: gpt-4
    rateLimits:
      rpm: 60
      tpm: 100000
scheduler:
  enabled: false
knowledge:
  embeddingModelPath: Xenova/bge-m3
  lancedbPath: ./lancedb
skills:
  directories: []
logging:
  level: info
`;

    await writeConfigAsync(configPath, yaml);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    expect(service.getTelegramConfig()).toBeUndefined();
  });
});

//#endregion Tests
