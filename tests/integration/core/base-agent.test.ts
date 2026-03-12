import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { BaseAgentBase } from "../../../src/agent/base-agent.js";
import type { IAgentResult } from "../../../src/agent/base-agent.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { thinkTool } from "../../../src/tools/think.tool.js";
import type { ToolSet, LanguageModel } from "ai";


let tempDir: string;
let originalHome: string;

/**
 * Concrete subclass of BaseAgentBase for testing purposes.
 * Exposes protected members publicly.
 */
class TestAgent extends BaseAgentBase {
  constructor(options?: { maxSteps?: number; contextWindow?: number }) {
    super(options);
  }

  public buildAgentPublic(model: LanguageModel, instructions: string, tools: ToolSet): void {
    this._buildAgent(model, instructions, tools);
  }

  public get initialized(): boolean {
    return this._initialized;
  }
}



//#region Tests

describe("BaseAgentBase", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-base-agent-"));
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
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should throw when processMessageAsync is called before initialization", async () => {
    const agent: TestAgent = new TestAgent();

    await expect(agent.processMessageAsync("hello")).rejects.toThrow(
      /not initialized/i,
    );
  });

  it("should mark as initialized after _buildAgent is called", () => {
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent();

    expect(agent.initialized).toBe(false);

    agent.buildAgentPublic(model, "Test instructions", {});

    expect(agent.initialized).toBe(true);
  });

  it("should use default maxSteps and contextWindow", () => {
    const agent: TestAgent = new TestAgent();

    expect(
      (agent as unknown as { _maxSteps: number })._maxSteps,
    ).toBe(300);
    expect(
      (agent as unknown as { _contextWindow: number })._contextWindow,
    ).toBe(128_000);
    // Threshold should be 70% of context window: 128000 * 0.70 = 89600
    expect(
      (agent as unknown as { _compactionTokenThreshold: number })._compactionTokenThreshold,
    ).toBe(89_600);
  });

  it("should accept custom maxSteps and contextWindow", () => {
    // With contextWindow of 100000, threshold should be 70000 (70%)
    const agent: TestAgent = new TestAgent({ maxSteps: 5, contextWindow: 100_000 });

    expect(
      (agent as unknown as { _maxSteps: number })._maxSteps,
    ).toBe(5);
    expect(
      (agent as unknown as { _contextWindow: number })._contextWindow,
    ).toBe(100_000);
    // Threshold should be 70% of context window: 100000 * 0.70 = 70000
    expect(
      (agent as unknown as { _compactionTokenThreshold: number })._compactionTokenThreshold,
    ).toBe(70_000);
  });

  it("should update contextWindow and recalculate compaction threshold", () => {
    const agent: TestAgent = new TestAgent();

    // Initial state
    expect(
      (agent as unknown as { _contextWindow: number })._contextWindow,
    ).toBe(128_000);
    expect(
      (agent as unknown as { _compactionTokenThreshold: number })._compactionTokenThreshold,
    ).toBe(89_600);

    // Update context window
    agent.updateContextWindow(200_000);

    // Verify updated values
    expect(
      (agent as unknown as { _contextWindow: number })._contextWindow,
    ).toBe(200_000);
    // 200000 * 0.70 = 140000
    expect(
      (agent as unknown as { _compactionTokenThreshold: number })._compactionTokenThreshold,
    ).toBe(140_000);
  });

  it("should force done by limiting activeTools on max steps without provider error", async () => {
    // Use maxSteps: 2 so the agent hits the force-done path on step 1 (>= maxSteps - 1).
    // This verifies the fix: enforce done by limiting activeTools to ["done"],
    // without sending forced toolChoice values.
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent({ maxSteps: 2 });

    agent.buildAgentPublic(model, "You are a helpful assistant. Always use the think tool before responding.", {
      think: thinkTool,
    });

    const result: IAgentResult = await agent.processMessageAsync(
      "What is 2 + 2? Think about it step by step.",
    );

    // The agent should complete without throwing a tool_choice provider error.
    // Step 0: model does something (think or text).
    // Step 1: stepNumber (1) >= maxSteps - 1 (1) → force done by restricting activeTools.
    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
    expect(result.text.length).toBeGreaterThan(0);
  }, 120_000);

  it("should force done by limiting activeTools on silent exit without provider error", async () => {
    // Give the model a prompt that encourages a plain text response without calling tools.
    // If the model produces text without a tool call, the silent-exit detection fires
    // and forces done by restricting activeTools to ["done"].
    // Either way (silent exit or normal done), the agent must complete without error.
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const agent: TestAgent = new TestAgent({ maxSteps: 10 });

    agent.buildAgentPublic(model, "You are a simple chatbot. Reply briefly to the user.", {
      think: thinkTool,
    });

    const result: IAgentResult = await agent.processMessageAsync("Say hello.");

    // The agent should complete without throwing a tool_choice provider error.
    // If the model tried to exit without calling done, the silent-exit handler fires
    // and forces done by restricting activeTools. If the model called done voluntarily,
    // that also works. Either path must succeed.
    expect(result).toBeDefined();
    expect(result.stepsCount).toBeGreaterThanOrEqual(1);
    expect(result.text.length).toBeGreaterThan(0);
  }, 120_000);
});

//#endregion Tests
