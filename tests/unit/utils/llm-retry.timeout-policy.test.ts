import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateObjectWithRetryAsync, generateTextWithRetryAsync } from "../../../src/utils/llm-retry.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { IAiConfig } from "../../../src/shared/types/index.js";
import { resetSingletons } from "../../utils/test-helpers.js";

const MIN_FLOOR_MS: number = 600_000;

const minimalAiConfig: IAiConfig = {
  provider: "openrouter",
  openrouter: {
    apiKey: "test-key",
    model: "openai/gpt-4o-mini",
    rateLimits: { rpm: 60, tpm: 100000 },
  },
};

vi.mock("ai", async (): Promise<Record<string, unknown>> => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

describe("llm-retry timeout policy floor", () => {
  let _scheduledTimeouts: number[];

  beforeEach(() => {
    resetSingletons();
    _scheduledTimeouts = [];

    vi.spyOn(LoggerService.getInstance(), "debug").mockReturnValue(undefined);
    vi.spyOn(LoggerService.getInstance(), "info").mockReturnValue(undefined);
    vi.spyOn(LoggerService.getInstance(), "warn").mockReturnValue(undefined);

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number): ReturnType<typeof setTimeout> => {
      if (typeof timeout === "number") {
        _scheduledTimeouts.push(timeout);
      }

      if (typeof handler === "function") {
        queueMicrotask(() => handler());
      }

      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    vi.spyOn(globalThis, "clearTimeout").mockImplementation((_id: ReturnType<typeof setTimeout>): void => {});

    vi.mocked(generateText).mockRejectedValue(new DOMException("Aborted", "AbortError"));
  });

  afterEach(() => {
    resetSingletons();
    vi.restoreAllMocks();
  });

  function setupMockConfigWithGenerationTimeout(configService: ConfigService, generationTimeoutMs: number): void {
    const originalGetConfig = configService.getConfig.bind(configService);
    vi.spyOn(configService, "getConfig").mockImplementation(() => {
      const config = originalGetConfig();

      return {
        ...config,
        ai: {
          ...config.ai,
          generationTimeoutMs,
        },
      };
    });

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    vi.spyOn(aiProviderService, "getGenerationTimeoutFloorMs").mockReturnValue(generationTimeoutMs);
  }

  async function expectTimeoutResolutionAsync(operation: Promise<unknown>, expectedTimeoutMs: number): Promise<void> {
    await expect(operation).rejects.toThrow("Aborted");
    expect(_scheduledTimeouts.length).toBeGreaterThan(0);
    expect(_scheduledTimeouts[0]).toBe(expectedTimeoutMs);
  }

  describe("generationTimeoutMs floor enforcement", () => {
    it("elevates schema_extraction policy timeout (60s) to 10-minute floor", async () => {
      AiProviderService.getInstance().initialize(minimalAiConfig);

      const configService: ConfigService = ConfigService.getInstance();
      setupMockConfigWithGenerationTimeout(configService, MIN_FLOOR_MS);

      await expectTimeoutResolutionAsync(
        generateTextWithRetryAsync({
          model: makeMockModel(),
          prompt: "test",
          retryOptions: {
            callType: "schema_extraction",
            maxAttempts: 1,
          },
        }),
        MIN_FLOOR_MS,
      );
    });

    it("elevates cron_history policy timeout (30s) to 10-minute floor", async () => {
      AiProviderService.getInstance().initialize(minimalAiConfig);

      const configService: ConfigService = ConfigService.getInstance();
      setupMockConfigWithGenerationTimeout(configService, MIN_FLOOR_MS);

      await expectTimeoutResolutionAsync(
        generateObjectWithRetryAsync({
          model: makeMockModel(),
          prompt: "test",
          schema: z.object({ ok: z.boolean() }),
          retryOptions: {
            callType: "cron_history",
            maxAttempts: 1,
          },
        }),
        MIN_FLOOR_MS,
      );
    });

    it("elevates explicit timeout below floor", async () => {
      AiProviderService.getInstance().initialize(minimalAiConfig);

      const configService: ConfigService = ConfigService.getInstance();
      setupMockConfigWithGenerationTimeout(configService, MIN_FLOOR_MS);

      await expectTimeoutResolutionAsync(
        generateTextWithRetryAsync({
          model: makeMockModel(),
          prompt: "test",
          retryOptions: {
            callType: "agent_primary",
            timeoutMs: 5_000,
            maxAttempts: 1,
          },
        }),
        MIN_FLOOR_MS,
      );
    });

    it("preserves explicit timeout above floor", async () => {
      AiProviderService.getInstance().initialize(minimalAiConfig);

      const configService: ConfigService = ConfigService.getInstance();
      setupMockConfigWithGenerationTimeout(configService, MIN_FLOOR_MS);

      const explicitTimeoutMs: number = 900_000;

      await expectTimeoutResolutionAsync(
        generateTextWithRetryAsync({
          model: makeMockModel(),
          prompt: "test",
          retryOptions: {
            callType: "agent_primary",
            timeoutMs: explicitTimeoutMs,
            maxAttempts: 1,
          },
        }),
        explicitTimeoutMs,
      );
    });

    it("honors configured generation timeout above 10-minute minimum", async () => {
      AiProviderService.getInstance().initialize(minimalAiConfig);

      const configService: ConfigService = ConfigService.getInstance();
      const customFloorMs: number = 720_000;
      setupMockConfigWithGenerationTimeout(configService, customFloorMs);

      await expectTimeoutResolutionAsync(
        generateTextWithRetryAsync({
          model: makeMockModel(),
          prompt: "test",
          retryOptions: {
            callType: "agent_primary",
            timeoutMs: 650_000,
            maxAttempts: 1,
          },
        }),
        customFloorMs,
      );
    });
  });
});

function makeMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    doGenerate: vi.fn(),
    doGenerateStream: vi.fn(),
  } as unknown as LanguageModel;
}
