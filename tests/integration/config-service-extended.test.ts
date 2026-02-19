import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../src/services/config.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-cfgext-test-"));
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

describe("ConfigService extended", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    (ConfigService as unknown as { _instance: null })._instance = null;
  });

  afterEach(async () => {
    (ConfigService as unknown as { _instance: null })._instance = null;
    await cleanupTempHomeAsync();
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

    const schedulerConfig = service.getSchedulerConfig();

    expect(schedulerConfig.enabled).toBe(false);
  });

  it("should return knowledge config via getKnowledgeConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const knowledgeConfig = service.getKnowledgeConfig();

    expect(knowledgeConfig.embeddingModelPath).toBe("Xenova/bge-m3");
  });

  it("should return skills config via getSkillsConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const skillsConfig = service.getSkillsConfig();

    expect(skillsConfig.directories).toEqual([]);
  });

  it("should return logging config via getLoggingConfig", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    const loggingConfig = service.getLoggingConfig();

    expect(loggingConfig.level).toBe("debug");
  });

  it("should save config to disk via saveConfigAsync", async () => {
    const configPath: string = path.join(tempDir, "config.yaml");

    await writeConfigAsync(configPath, VALID_YAML);

    const service: ConfigService = ConfigService.getInstance();

    await service.initializeAsync(configPath);

    await service.saveConfigAsync();

    // Re-read from disk — should not throw and contain same data
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

    // Verify it was persisted to disk
    const savedContent: string = await fs.readFile(configPath, "utf-8");

    expect(savedContent).toContain("warn");
  });
});

//#endregion Tests
