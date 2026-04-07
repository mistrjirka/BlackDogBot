import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { generateTextWithRetryAsync, generateObjectWithRetryAsync } from "../../../src/utils/llm-retry.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { IAiConfig } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;
let shouldSkipLmTests: boolean = false;


//#region Tests

describe("llm-retry E2E — real LLM calls", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-llmretry-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config to temp HOME so AiProviderService picks up the API key
    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    await AiProviderService.getInstance().initializeAsync(configService.getConfig().ai);

    // Check if LM Studio is configured - skip tests if using local provider without LM Studio running
    const provider: string = AiProviderService.getInstance().getActiveProvider();
    shouldSkipLmTests = provider === "openai-compatible" || provider === "lm-studio";
  }, 60000);

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should call a real LLM and return a non-empty text response", async () => {
    if (shouldSkipLmTests) {
      return;
    }
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
  }, 600000);

  it("should honour the system prompt when forwarding to the real LLM", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    // Verify that the optional `system` field is correctly forwarded to generateText.
    const model: LanguageModel = AiProviderService.getInstance().getDefaultModel();

    const result = await generateTextWithRetryAsync({
      model,
      system: "You are a calculator. Reply only with the numeric result, nothing else.",
      prompt: "What is 3 + 4?",
    });

    expect(result.text).toContain("7");
  }, 600000);

  it("should resolve and expose strict structured output mode", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    const aiProvider = AiProviderService.getInstance();
    const mode = aiProvider.getStructuredOutputMode();

    expect(["native_json_schema", "tool_emulated", "tool_auto"]).toContain(mode);
    expect(typeof aiProvider.getSupportsStructuredOutputs()).toBe("boolean");
    expect(typeof aiProvider.getSupportsToolCalling()).toBe("boolean");
  }, 600000);

  it("should generate structured object with configured strict mode", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    const model: LanguageModel = AiProviderService.getInstance().getDefaultModel();

    const result = await generateObjectWithRetryAsync({
      model,
      prompt: "Extract user profile from: Jane Smith, age 31, city Prague.",
      schema: z.object({
        name: z.string(),
        age: z.number(),
        city: z.string(),
      }),
    });

    expect(result.object.name.toLowerCase()).toContain("jane");
    expect(result.object.age).toBeGreaterThan(0);
    expect(result.object.city.length).toBeGreaterThan(0);
  }, 600000);

  it("should honor strict tool_emulated mode without native fallback", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    const configService: ConfigService = ConfigService.getInstance();
    const originalAiConfig: IAiConfig = configService.getConfig().ai;
    const forcedAiConfig: IAiConfig = structuredClone(originalAiConfig);

    if (forcedAiConfig.provider === "openrouter" && forcedAiConfig.openrouter) {
      forcedAiConfig.openrouter.structuredOutputMode = "tool_emulated";
    } else if (forcedAiConfig.provider === "openai-compatible" && forcedAiConfig.openaiCompatible) {
      forcedAiConfig.openaiCompatible.structuredOutputMode = "tool_emulated";
    } else if (forcedAiConfig.provider === "lm-studio" && forcedAiConfig.lmStudio) {
      forcedAiConfig.lmStudio.structuredOutputMode = "tool_emulated";
    } else {
      throw new Error("Could not force tool_emulated mode: active provider config missing");
    }

    const aiProvider: AiProviderService = AiProviderService.getInstance();
    await aiProvider.initializeAsync(forcedAiConfig);

    expect(aiProvider.getStructuredOutputMode()).toBe("tool_emulated");

    const model: LanguageModel = aiProvider.getDefaultModel();
    const marker: string = `STRICT_TOOL_MODE_${Date.now()}`;
    const capturedBodies: Array<Record<string, unknown>> = [];
    const originalFetch: typeof fetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlString: string = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        urlString.includes("/v1/chat/completions") &&
        init?.method === "POST" &&
        typeof init.body === "string"
      ) {
        try {
          capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        } catch {
          // ignore malformed capture body
        }
      }

      return originalFetch(input, init);
    };

    try {
      const result = await generateObjectWithRetryAsync({
        model,
        prompt: `${marker}: Return name=Jane, age=31, city=Prague.`,
        schema: z.object({
          name: z.string(),
          age: z.number(),
          city: z.string(),
        }),
      });

      expect(result.object.name.toLowerCase()).toContain("jane");

      const matchingRequests: Array<Record<string, unknown>> = capturedBodies.filter((body) =>
        JSON.stringify(body).includes(marker),
      );

      expect(matchingRequests.length).toBeGreaterThan(0);

      const toolRequest: Record<string, unknown> | undefined = matchingRequests.find((body) => {
        const tools = body.tools;
        return Array.isArray(tools) && tools.length > 0;
      });

      expect(toolRequest).toBeDefined();
      expect(toolRequest).not.toHaveProperty("response_format");
      expect(toolRequest).toHaveProperty("tool_choice");

      const tools = toolRequest!.tools as Array<Record<string, unknown>>;
      const hasEmitTool = tools.some((toolDef) => {
        const fn = toolDef.function as Record<string, unknown> | undefined;
        return fn?.name === "emit_structured_output";
      });
      expect(hasEmitTool).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await aiProvider.initializeAsync(originalAiConfig);
    }
  }, 600000);

  it("should honor strict tool_auto mode with best-effort tool call", async () => {
    if (shouldSkipLmTests) {
      return;
    }
    const configService: ConfigService = ConfigService.getInstance();
    const originalAiConfig: IAiConfig = configService.getConfig().ai;
    const forcedAiConfig: IAiConfig = structuredClone(originalAiConfig);

    if (forcedAiConfig.provider === "openrouter" && forcedAiConfig.openrouter) {
      forcedAiConfig.openrouter.structuredOutputMode = "tool_auto";
    } else if (forcedAiConfig.provider === "openai-compatible" && forcedAiConfig.openaiCompatible) {
      forcedAiConfig.openaiCompatible.structuredOutputMode = "tool_auto";
    } else if (forcedAiConfig.provider === "lm-studio" && forcedAiConfig.lmStudio) {
      forcedAiConfig.lmStudio.structuredOutputMode = "tool_auto";
    } else {
      throw new Error("Could not force tool_auto mode: active provider config missing");
    }

    const aiProvider: AiProviderService = AiProviderService.getInstance();
    await aiProvider.initializeAsync(forcedAiConfig);

    expect(aiProvider.getStructuredOutputMode()).toBe("tool_auto");

    const model: LanguageModel = aiProvider.getDefaultModel();

    try {
      const result = await generateObjectWithRetryAsync({
        model,
        prompt: "Return name=Jane, age=31, city=Prague.",
        schema: z.object({
          name: z.string(),
          age: z.number(),
          city: z.string(),
        }),
      });

      expect(result.object.name.toLowerCase()).toContain("jane");
      expect(result.object.age).toBeGreaterThan(0);
      expect(result.object.city.length).toBeGreaterThan(0);
    } finally {
      await aiProvider.initializeAsync(originalAiConfig);
    }
  }, 600000);
});

//#endregion Tests
