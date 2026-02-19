import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { BaseAgentBase } from "../../src/agent/base-agent.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { ToolSet, LanguageModel } from "ai";

//#region Helpers

/**
 * Concrete subclass of BaseAgentBase for testing purposes.
 * Exposes protected methods publicly.
 */
class TestAgent extends BaseAgentBase {
  constructor(options?: { maxSteps?: number; compactionThreshold?: number }) {
    super(options);
  }

  public buildAgentPublic(model: LanguageModel, instructions: string, tools: ToolSet): void {
    this._buildAgent(model, instructions, tools);
  }

  public get initialized(): boolean {
    return this._initialized;
  }
}

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
}

function createMockModel(): LanguageModel {
  return {} as LanguageModel;
}

//#endregion Helpers

//#region Tests

describe("BaseAgentBase", () => {
  beforeEach(() => {
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(() => {
    resetSingletons();
    vi.restoreAllMocks();
  });

  it("should throw when processMessageAsync is called before initialization", async () => {
    const agent: TestAgent = new TestAgent();

    await expect(agent.processMessageAsync("hello")).rejects.toThrow(
      /not initialized/i,
    );
  });

  it("should mark as initialized after _buildAgent is called", () => {
    const agent: TestAgent = new TestAgent();

    expect(agent.initialized).toBe(false);

    agent.buildAgentPublic(createMockModel(), "Test instructions", {});

    expect(agent.initialized).toBe(true);
  });

  it("should use default maxSteps and compactionThreshold", () => {
    const agent: TestAgent = new TestAgent();

    expect(
      (agent as unknown as { _maxSteps: number })._maxSteps,
    ).toBe(20);
    expect(
      (agent as unknown as { _compactionThreshold: number })._compactionThreshold,
    ).toBe(40);
  });

  it("should accept custom maxSteps and compactionThreshold", () => {
    const agent: TestAgent = new TestAgent({ maxSteps: 5, compactionThreshold: 10 });

    expect(
      (agent as unknown as { _maxSteps: number })._maxSteps,
    ).toBe(5);
    expect(
      (agent as unknown as { _compactionThreshold: number })._compactionThreshold,
    ).toBe(10);
  });
});

//#endregion Tests
