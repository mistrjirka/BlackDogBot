import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";

//#region Types

interface ICapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

interface IRawConfig {
  ai?: {
    provider?: string;
    openaiCompatible?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      rateLimits?: {
        rpm?: number;
        tpm?: number;
      };
      contextWindow?: number;
      supportsStructuredOutputs?: boolean;
      requestTimeout?: number;
    };
    lmStudio?: {
      model?: string;
    };
  };
}

//#endregion Types

//#region Setup

const localBaseUrl: string = "http://localhost:2345";

let tempDir: string;
let originalHome: string;
let tempConfigPath: string;
let endpointReachable: boolean = false;

async function isEndpointReachableAsync(): Promise<boolean> {
  const abortController: AbortController = new AbortController();
  const timeoutId: NodeJS.Timeout = setTimeout(() => abortController.abort(), 3000);

  try {
    const response: Response = await fetch(`${localBaseUrl}/v1/models`, {
      method: "GET",
      signal: abortController.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-local-reasoning-e2e-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons();

  const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".betterclaw");
  tempConfigPath = path.join(tempConfigDir, "config.yaml");

  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, tempConfigPath);

  endpointReachable = await isEndpointReachableAsync();
});

afterAll(async () => {
  process.env.HOME = originalHome;
  resetSingletons();
  await fs.rm(tempDir, { recursive: true, force: true });
});

//#endregion Setup

//#region Tests

describe("OpenAI-compatible local reasoning middleware E2E", () => {
  it("should extract <think> client-side and preserve reasoning_content in the next tool-call step", async () => {
    if (!endpointReachable) {
      console.log(`Skipping: local OpenAI-compatible endpoint is not reachable at ${localBaseUrl}`);
      return;
    }

    const rawConfigText: string = await fs.readFile(tempConfigPath, "utf-8");
    const rawConfig: IRawConfig = parseYaml(rawConfigText) as IRawConfig;

    const modelId: string | undefined =
      process.env.BETTERCLAW_LOCAL_OPENAI_MODEL ||
      rawConfig.ai?.openaiCompatible?.model ||
      rawConfig.ai?.lmStudio?.model;

    if (!modelId) {
      console.log("Skipping: could not resolve model id for local OpenAI-compatible endpoint");
      return;
    }

    const mergedOpenAiCompatible = {
      ...(rawConfig.ai?.openaiCompatible ?? {}),
      baseUrl: localBaseUrl,
      apiKey: rawConfig.ai?.openaiCompatible?.apiKey ?? "local-key",
      model: modelId,
      rateLimits: {
        rpm: rawConfig.ai?.openaiCompatible?.rateLimits?.rpm ?? 120,
        tpm: rawConfig.ai?.openaiCompatible?.rateLimits?.tpm ?? 200000,
      },
      supportsStructuredOutputs: true,
    };

    const nextConfig: IRawConfig = {
      ...rawConfig,
      ai: {
        ...(rawConfig.ai ?? {}),
        provider: "openai-compatible",
        openaiCompatible: mergedOpenAiCompatible,
      },
    };

    await fs.writeFile(tempConfigPath, stringifyYaml(nextConfig), "utf-8");

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    await aiProviderService.initializeAsync(configService.getConfig().ai);

    const supportsReasoningFormat: boolean =
      (aiProviderService as unknown as { _supportsReasoningFormat: boolean })._supportsReasoningFormat;

    if (!supportsReasoningFormat) {
      console.log("Skipping: local endpoint does not report reasoning_format support");
      return;
    }

    const model: LanguageModel = aiProviderService.getDefaultModel();

    const capturedRequests: ICapturedRequest[] = [];
    const originalFetch: typeof fetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlString: string = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        urlString.includes(`${localBaseUrl}/v1/chat/completions`) &&
        init?.method === "POST" &&
        typeof init.body === "string"
      ) {
        try {
          capturedRequests.push({
            url: urlString,
            body: JSON.parse(init.body) as Record<string, unknown>,
          });
        } catch {
          // Ignore parse failures; test assertions will fail if expected structure is missing.
        }
      }

      return originalFetch(input, init);
    };

    try {
      const result = await generateText({
        model,
        tools: {
          calculator: tool({
            description: "Adds two numbers",
            inputSchema: z.object({
              a: z.number(),
              b: z.number(),
            }),
            execute: async ({ a, b }): Promise<{ result: number }> => ({ result: a + b }),
          }),
        },
        toolChoice: { type: "tool", toolName: "calculator" },
        stopWhen: stepCountIs(2),
        maxRetries: 0,
        prompt: "Call calculator with a=2 and b=2. After tool result, answer with exactly 4.",
      });

      expect(result.steps.length).toBeGreaterThanOrEqual(2);

      const chatRequests: ICapturedRequest[] = capturedRequests.filter((request: ICapturedRequest) => {
        const messages: unknown = request.body.messages;
        return Array.isArray(messages);
      });

      expect(chatRequests.length).toBeGreaterThanOrEqual(2);

      for (const request of chatRequests) {
        expect(request.body.reasoning_format).toBe("none");
      }

      const secondStepRequest: ICapturedRequest | undefined = chatRequests.find((request: ICapturedRequest) => {
        const messages = request.body.messages as Array<Record<string, unknown>>;
        return messages.some((message: Record<string, unknown>) =>
          message.role === "assistant" &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0
        );
      });

      expect(secondStepRequest).toBeDefined();

      const assistantToolCallMessage = (secondStepRequest!.body.messages as Array<Record<string, unknown>>)
        .find((message: Record<string, unknown>) =>
          message.role === "assistant" &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0
        );

      expect(assistantToolCallMessage).toBeDefined();
      expect(assistantToolCallMessage).not.toHaveProperty("content");
      expect(typeof assistantToolCallMessage!.reasoning_content).toBe("string");
      expect((assistantToolCallMessage!.reasoning_content as string).trim().length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 120000);
});

//#endregion Tests
