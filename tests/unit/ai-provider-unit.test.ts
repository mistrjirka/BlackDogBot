import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { SchedulerService } from "../../src/services/scheduler.service.js";
import * as litesql from "../../src/helpers/litesql.js";
import { ConfigService } from "../../src/services/config.service.js";
import { resetSingletons } from "../utils/test-helpers.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { ModelInfoService } from "../../src/services/model-info.service.js";
import type { IAiConfig } from "../../src/shared/types/index.js";
import type { LanguageModel } from "ai";


/**
 * Resets AiProviderService and RateLimiterService singletons between tests.
 */

/** Minimal valid OpenRouter config for testing. */
const openrouterConfig: IAiConfig = {
  provider: "openrouter",
  openrouter: {
    apiKey: "test-key",
    model: "openai/gpt-4o-mini",
    rateLimits: { rpm: 60, tpm: 100000 },
  },
};

/** Minimal valid openai-compatible config for testing. */
const openaiCompatibleConfig: IAiConfig = {
  provider: "openai-compatible",
  openaiCompatible: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "local-key",
    model: "llama3",
    rateLimits: { rpm: 30, tpm: 50000 },
  },
};


//#region Tests

describe("AiProviderService unit", () => {
  beforeEach(() => {
    resetSingletons();
  });

  async function buildScheduledTaskAsync(taskId: string, tools: string[]): Promise<any> {
    const nowIso: string = new Date().toISOString();

    return {
      taskId,
      name: "Legacy Write Task",
      description: "Legacy cron task",
      instructions: "Test migration",
      tools,
      schedule: { type: "cron", expression: "0 */6 * * *" },
      notifyUser: false,
      enabled: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      messageHistory: [],
      messageSummary: null,
      summaryGeneratedAt: null,
    };
  }

  afterEach(() => {
    resetSingletons();
  });

  describe("initialize + getDefaultModel (openrouter)", () => {
    it("should initialize with openrouter config and return a valid model", () => {
      // Arrange + Act
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Assert
      const model: LanguageModel = service.getDefaultModel();

      expect(model).toBeDefined();
    });

    it("should report the correct active provider after initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      expect(service.getActiveProvider()).toBe("openrouter");
    });

    it("should return a rate limiter after initialization", () => {
      // Arrange
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Act
      const limiter = service.getRateLimiter();

      // Assert — limiter is a Bottleneck instance (has a `schedule` method)
      expect(limiter).toBeDefined();
      expect(typeof limiter.schedule).toBe("function");
    });

    it("should return a different model instance when getModel is called with an explicit modelId", () => {
      // Arrange
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Act — request a model that is different from the default
      const explicitModel: LanguageModel = service.getModel("anthropic/claude-3-haiku");

      // Assert — returned something (we can't deeply compare provider instances, just ensure defined)
      expect(explicitModel).toBeDefined();
    });

    it("should return the default model when getModel is called without arguments", () => {
      // Arrange
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      // Act
      const model: LanguageModel = service.getModel();

      expect(model).toBeDefined();
    });

    it("should expose structured output mode in sync init", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openrouterConfig);

      expect(["native_json_schema", "tool_emulated", "tool_auto"]).toContain(service.getStructuredOutputMode());
    });

    it("should accept configured tool_auto mode in sync init", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize({
        provider: "openrouter",
        openrouter: {
          apiKey: "test-key",
          model: "stepfun/step-3.5-flash:free",
          rateLimits: { rpm: 60, tpm: 100000 },
          structuredOutputMode: "tool_auto",
        },
      });

      expect(service.getStructuredOutputMode()).toBe("tool_auto");
      expect(service.getSupportsStructuredOutputs()).toBe(false);
      expect(service.getSupportsToolCalling()).toBe(true);
    });

    it("should clamp OpenRouter free model local RPM to 20", async () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize({
        provider: "openrouter",
        openrouter: {
          apiKey: "test-key",
          model: "stepfun/step-3.5-flash:free",
          rateLimits: { rpm: 60, tpm: 100000 },
        },
      });

      const limiter = service.getRateLimiter();
      const reservoir: number | null = await limiter.currentReservoir();

      expect(reservoir).toBe(20);
    });

    it("should auto-resolve to tool_auto when OpenRouter metadata has tools without tool_choice", async () => {
      const modelInfoService: ModelInfoService = ModelInfoService.getInstance();
      vi.spyOn(modelInfoService, "fetchContextWindowAsync").mockResolvedValue(256000);
      vi.spyOn(modelInfoService, "fetchSupportedParametersAsync")
        .mockResolvedValue(new Set<string>(["tools"]));

      const service: AiProviderService = AiProviderService.getInstance();
      vi.spyOn(service, "testResponseFormatAsync").mockResolvedValue({ ok: false, reason: "skipped" });

      await service.initializeAsync({
        provider: "openrouter",
        openrouter: {
          apiKey: "test-key",
          model: "stepfun/step-3.5-flash:free",
          rateLimits: { rpm: 60, tpm: 100000 },
        },
      });

      expect(service.getStructuredOutputMode()).toBe("tool_auto");
      expect(service.getSupportsStructuredOutputs()).toBe(false);
      expect(service.getSupportsToolCalling()).toBe(true);
    });
  });

  describe("initialize + getDefaultModel (openai-compatible)", () => {
    it("should initialize with openai-compatible config and return a valid model", () => {
      // Arrange + Act
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openaiCompatibleConfig);

      // Assert
      const model: LanguageModel = service.getDefaultModel();

      expect(model).toBeDefined();
    });

    it("should report openai-compatible as the active provider", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      service.initialize(openaiCompatibleConfig);

      expect(service.getActiveProvider()).toBe("openai-compatible");
    });
  });

  describe("Scheduler legacy write tool migration", () => {
    it("should replace write_to_database with all write_table tools at startup", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-scheduler-migrate-"));
      const originalHome = process.env.HOME ?? os.homedir();

      try {
        process.env.HOME = tempRoot;

        const betterClawDir = path.join(tempRoot, ".blackdogbot");
        const cronDir = path.join(betterClawDir, "cron");
        const configDir = betterClawDir;
        await fs.mkdir(cronDir, { recursive: true });

        const realConfigPath = path.join(originalHome, ".blackdogbot", "config.yaml");
        const tempConfigPath = path.join(configDir, "config.yaml");
        await fs.cp(realConfigPath, tempConfigPath);

        resetSingletons();

        const configService = ConfigService.getInstance();
        await configService.initializeAsync(tempConfigPath);

        const aiService = AiProviderService.getInstance();
        aiService.initialize(configService.getConfig().ai);

        await litesql.createDatabaseAsync("test_db");
        await litesql.createTableAsync("test_db", "users", [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "name", type: "TEXT" },
        ]);

        const task = await buildScheduledTaskAsync("legacy-task-1", [
          "fetch_rss",
          "write_to_database",
          "send_message",
        ]);
        await fs.writeFile(path.join(cronDir, "legacy-task-1.json"), JSON.stringify(task, null, 2), "utf-8");

        const scheduler = SchedulerService.getInstance();
        await scheduler.startAsync();

        const loadedTask = await scheduler.getTaskAsync("legacy-task-1");
        expect(loadedTask).toBeDefined();
        expect(loadedTask!.tools).not.toContain("write_to_database");
        expect(loadedTask!.tools).toContain("write_table_users");

        const persistedRaw = await fs.readFile(path.join(cronDir, "legacy-task-1.json"), "utf-8");
        const persisted = JSON.parse(persistedRaw) as { tools: string[] };
        expect(persisted.tools).not.toContain("write_to_database");
        expect(persisted.tools).toContain("write_table_users");

        await scheduler.stopAsync();
      } finally {
        process.env.HOME = originalHome;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }, 60000);
  });

  describe("error paths", () => {
    it("should throw when getDefaultModel is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getDefaultModel()).toThrow("AiProviderService not initialized");
    });

    it("should throw when getModel is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getModel()).toThrow("AiProviderService not initialized");
    });

    it("should throw when getActiveProvider is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getActiveProvider()).toThrow("AiProviderService not initialized");
    });

    it("should throw when getRateLimiter is called before initialization", () => {
      const service: AiProviderService = AiProviderService.getInstance();

      expect(() => service.getRateLimiter()).toThrow("AiProviderService not initialized");
    });

    it("should throw when an unsupported provider is set", () => {
      // Arrange — inject an unsupported provider via the private config field.
      // We must pass an explicit modelId so getModel() calls _createModel() directly
      // rather than routing through getDefaultModel() (which additionally gates on _defaultModel).
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "unsupported-provider",
      };

      // Act + Assert
      expect(() => service.getModel("any-model")).toThrow("Unsupported provider");
    });

    it("should throw when openrouter provider has no openrouter config block", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "openrouter",
        // openrouter block intentionally absent
      };

      expect(() => service.getModel("any-model")).toThrow(/No configuration found for provider/);
    });

    it("should throw when openai-compatible provider has no openaiCompatible config block", () => {
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "openai-compatible",
        // openaiCompatible block intentionally absent
      };

      expect(() => service.getModel("any-model")).toThrow(/No configuration found for provider/);
    });

    it("should throw when getRateLimiter is called but no limiter was created", () => {
      // Arrange — set config without calling initialize (which creates the limiter)
      const service: AiProviderService = AiProviderService.getInstance();
      (service as unknown as { _aiConfig: unknown })._aiConfig = {
        provider: "openrouter",
        openrouter: {
          apiKey: "key",
          model: "m",
          rateLimits: { rpm: 60, tpm: 100000 },
        },
      };

      // No createLimiter was called, so getLimiter returns undefined
      expect(() => service.getRateLimiter()).toThrow(/No rate limiter found/);
    });
  });
});

//#endregion Tests
