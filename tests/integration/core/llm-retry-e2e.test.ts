import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { generateTextWithRetryAsync } from "../../../src/utils/llm-retry.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { LanguageModel } from "ai";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("llm-retry E2E — real LLM calls", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-llmretry-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config to temp HOME so AiProviderService picks up the API key
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    AiProviderService.getInstance().initialize(configService.getConfig().ai);
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should call a real LLM and return a non-empty text response", async () => {
    // This test intentionally makes a real API call to verify that
    // generateTextWithRetryAsync is wired correctly end-to-end when no failures occur.
    const model: LanguageModel = AiProviderService.getInstance().getDefaultModel();

    const result = await generateTextWithRetryAsync({
      model,
      prompt: "Reply with exactly the word 'ok' and nothing else.",
    });

    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text.toLowerCase()).toContain("ok");
  }, 60000);

  it("should honour the system prompt when forwarding to the real LLM", async () => {
    // Verify that the optional `system` field is correctly forwarded to generateText.
    const model: LanguageModel = AiProviderService.getInstance().getDefaultModel();

    const result = await generateTextWithRetryAsync({
      model,
      system: "You are a calculator. Reply only with the numeric result, nothing else.",
      prompt: "What is 3 + 4?",
    });

    expect(result.text).toContain("7");
  }, 60000);
});

//#endregion Tests
