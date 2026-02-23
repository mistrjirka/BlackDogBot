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

const VALID_YAML: string = `
ai:
  provider: openrouter
  openrouter:
    apiKey: test-key-123
    model: gpt-4
    rateLimits:
      rpm: 60
      tpm: 100000
telegram:
  botToken: "123456:ABC"
scheduler:
  enabled: false
knowledge:
  embeddingModelPath: Xenova/bge-m3
  lancedbPath: ./lancedb
skills:
  directories: []
logging:
  level: debug
`;

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

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const config = service.getConfig();

    expect(config.ai.provider).toBe("openrouter");
    expect(config.ai.openrouter?.apiKey).toBe("test-key-123");
    expect(config.scheduler.enabled).toBe(false);
    expect(config.logging.level).toBe("debug");
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

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const telegramConfig = service.getTelegramConfig();

    expect(telegramConfig).toBeDefined();
    expect(telegramConfig!.botToken).toBe("123456:ABC");
  });

  it("should return undefined for telegram when not configured", async () => {
    const configPath: string = path.join(tempDir, ".betterclaw", "config.yaml");

    const yamlNoTelegram: string = `
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

    await writeConfigAsync(configPath, yamlNoTelegram);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    expect(service.getTelegramConfig()).toBeUndefined();
  });

  it("should throw when getConfig is called before initialization", () => {
    const service: ConfigService = ConfigService.getInstance();

    expect(() => service.getConfig()).toThrow("ConfigService not initialized");
  });

  it("should return AI config via getAiConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const aiConfig = service.getAiConfig();

    expect(aiConfig.provider).toBe("openrouter");
    expect(aiConfig.openrouter?.model).toBe("gpt-4");
  });

  it("should return scheduler config via getSchedulerConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    expect(service.getSchedulerConfig().enabled).toBe(false);
  });

  it("should return knowledge config via getKnowledgeConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    expect(service.getKnowledgeConfig().embeddingModelPath).toBe("Xenova/bge-m3");
  });

  it("should return skills config via getSkillsConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    expect(service.getSkillsConfig().directories).toEqual([]);
  });

  it("should return logging config via getLoggingConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    expect(service.getLoggingConfig().level).toBe("debug");
  });

  it("should save config to disk via saveConfigAsync", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    await service.saveConfigAsync();

    const savedContent: string = await fs.readFile(configPath, "utf-8");

    expect(savedContent).toContain("openrouter");
    expect(savedContent).toContain("test-key-123");
  });

  it("should update config and persist via updateConfigAsync", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    await service.updateConfigAsync({
      logging: { level: "warn" },
    });

    expect(service.getLoggingConfig().level).toBe("warn");

    const savedContent: string = await fs.readFile(configPath, "utf-8");

    expect(savedContent).toContain("warn");
  });
});

//#endregion Tests
