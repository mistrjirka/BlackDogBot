import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { EmbeddingService } from "../../../src/services/embedding.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;
let shouldRunLiveTest: boolean = false;
let skipReason: string = "";

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (EmbeddingService as unknown as { _instance: null })._instance = null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct: number = 0;
  let normA: number = 0;
  let normB: number = 0;

  for (let i: number = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

//#endregion Helpers

//#region Tests

describe("EmbeddingService OpenRouter E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-embedding-openrouter-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.copyFile(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const config = configService.getConfig();
    const isOpenRouterProvider: boolean = config.knowledge.embeddingProvider === "openrouter";
    const hasModel: boolean = Boolean(config.knowledge.embeddingOpenRouterModel?.trim());
    const apiKey: string =
      config.knowledge.embeddingOpenRouterApiKey ??
      config.ai.openrouter?.apiKey ??
      process.env.OPENROUTER_API_KEY ??
      "";

    if (!isOpenRouterProvider) {
      skipReason = "knowledge.embeddingProvider is not set to openrouter";
      return;
    }

    if (!hasModel) {
      skipReason = "knowledge.embeddingOpenRouterModel is missing";
      return;
    }

    if (!apiKey) {
      skipReason = "OpenRouter API key missing (knowledge.embeddingOpenRouterApiKey / ai.openrouter.apiKey / OPENROUTER_API_KEY)";
      return;
    }

    shouldRunLiveTest = true;
  }, 120000);

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should perform real OpenRouter embedding calls", async () => {
    if (!shouldRunLiveTest) {
      console.log(`Skipping live OpenRouter embedding E2E: ${skipReason}`);
      return;
    }

    const config = ConfigService.getInstance().getConfig();
    const apiKey: string =
      config.knowledge.embeddingOpenRouterApiKey ??
      config.ai.openrouter?.apiKey ??
      process.env.OPENROUTER_API_KEY ??
      "";

    const service: EmbeddingService = EmbeddingService.getInstance();

    await service.initializeAsync(
      config.knowledge.embeddingModelPath,
      config.knowledge.embeddingDtype,
      config.knowledge.embeddingDevice,
      "openrouter",
      config.knowledge.embeddingOpenRouterModel,
      apiKey,
    );

    const v1: number[] = await service.embedAsync("The cat is sleeping on the sofa.");
    const v2: number[] = await service.embedAsync("A cat sleeps on a couch.");
    const v3: number[] = await service.embedAsync("Bitcoin block headers contain hashes.");

    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBe(v1.length);
    expect(v3.length).toBe(v1.length);

    const s12: number = cosineSimilarity(v1, v2);
    const s13: number = cosineSimilarity(v1, v3);

    expect(s12).toBeGreaterThan(s13);

    const batch: number[][] = await service.embedBatchAsync([
      "hello",
      "world",
    ]);

    expect(batch.length).toBe(2);
    expect(batch[0].length).toBe(v1.length);
    expect(batch[1].length).toBe(v1.length);
  }, 120000);
});

//#endregion Tests
