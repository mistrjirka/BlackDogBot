import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateText, LanguageModel } from "ai";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";


let tempDir: string;
let originalHome: string;
let shouldSkipLmTests: boolean = false;


//#region Tests

describe("AiProvider E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-ai-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config to temp HOME
    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    // Initialize services
    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();

    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();

    aiProviderService.initialize(configService.getConfig().ai);

    // Check if LM Studio is configured - skip tests if using local provider without LM Studio running
    const provider: string = aiProviderService.getActiveProvider();
    shouldSkipLmTests = provider === "openai-compatible" || provider === "lm-studio";
  }, 60000);

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should get a valid model from AiProviderService", () => {
    if (shouldSkipLmTests) {
      return;
    }
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getDefaultModel();

    expect(model).toBeDefined();
    expect(aiProviderService.getActiveProvider()).toBe("openrouter");
  });

  it("should make a real LLM call via generateText and get a response", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getDefaultModel();

    const result = await generateText({
      model,
      prompt: "Reply with exactly the word 'pong' and nothing else.",
    });

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain("pong");
  }, 600000);

  it("should handle a slightly more complex prompt", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getDefaultModel();

    const result = await generateText({
      model,
      prompt: "What is 2 + 2? Reply with only the number.",
    });

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(result.text).toContain("4");
  }, 600000);
});

//#endregion Tests
