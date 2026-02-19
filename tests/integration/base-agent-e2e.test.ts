import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { BaseAgentBase, type IAgentResult } from "../../src/agent/base-agent.js";
import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import { thinkTool } from "../../src/tools/index.js";
import type { ToolSet, LanguageModel } from "ai";

//#region Helpers

let tempDir: string;
let originalHome: string;

/**
 * Concrete subclass of BaseAgentBase for e2e testing.
 */
class TestAgent extends BaseAgentBase {
  constructor(options?: { maxSteps?: number; compactionThreshold?: number }) {
    super(options);
  }

  public initializeWithModel(model: LanguageModel, instructions: string, tools: ToolSet): void {
    this._buildAgent(model, instructions, tools);
  }
}

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("BaseAgentBase E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-base-agent-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);
  }, 120000);

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should process a message with a real LLM and return a result", async () => {
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent();

    agent.initializeWithModel(
      model,
      "You are a helpful assistant. When asked a question, answer it briefly and call done.",
      { think: thinkTool },
    );

    const result: IAgentResult = await agent.processMessageAsync(
      "What is 2 + 2? Answer with just the number and call done.",
    );

    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
  }, 120000);

  it("should return stepsCount matching the number of agent steps", async () => {
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent();

    agent.initializeWithModel(
      model,
      "You are a helpful assistant. Always use the think tool before answering. Then call done.",
      { think: thinkTool },
    );

    const result: IAgentResult = await agent.processMessageAsync(
      "Think about what 3 * 7 equals using the think tool, then call done.",
    );

    expect(result).toBeDefined();
    // At minimum: think step + done step = 2 steps
    expect(result.stepsCount).toBeGreaterThanOrEqual(2);
  }, 120000);
});

//#endregion Tests
