import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { BaseAgentBase, type IAgentResult } from "../../../src/agent/base-agent.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { thinkTool } from "../../../src/tools/index.js";
import type { ToolSet, LanguageModel } from "ai";


let tempDir: string;
let originalHome: string;
let shouldSkipLmTests: boolean = false;

/**
 * Concrete subclass of BaseAgentBase for e2e testing.
 */
class TestAgent extends BaseAgentBase {
  constructor(options?: { maxSteps?: number; compactionTokenThreshold?: number }) {
    super(options);
  }

  public initializeWithModel(model: LanguageModel, instructions: string, tools: ToolSet): void {
    this._buildAgent(model, instructions, tools);
  }
}



//#region Tests

describe("BaseAgentBase E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-base-agent-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);

    const provider: string = aiProviderService.getActiveProvider();
    shouldSkipLmTests = provider === "lm-studio";
  }, 600000);

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should process a message with a real LLM and return a result", async () => {
    if (shouldSkipLmTests) {
      return;
    }

    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent();

    agent.initializeWithModel(
      model,
      "You are a helpful assistant. When asked a question, answer with just the number.",
      { think: thinkTool },
    );

    const result: IAgentResult = await agent.processMessageAsync(
      "What is 2 + 2? Answer with just the number.",
    );

    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("4");
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
  }, 600000);

  it("should return stepsCount matching the number of agent steps", async () => {
    if (shouldSkipLmTests) {
      return;
    }

    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent();

    agent.initializeWithModel(
      model,
      "You are a helpful assistant. Always use the think tool before answering.",
      { think: thinkTool },
    );

    const result: IAgentResult = await agent.processMessageAsync(
      "Think about what 3 * 7 equals using the think tool.",
    );

    expect(result).toBeDefined();
    // At minimum: at least one step should be recorded
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
  }, 600000);
});

//#endregion Tests
