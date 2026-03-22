import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LanguageModel, ModelMessage } from "ai";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { compactMessagesSummaryOnlyAsync } from "../../../src/utils/summarization-compaction.js";
import { generateTextWithRetryAsync } from "../../../src/utils/llm-retry.js";

//#region Types

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
        maxConcurrent?: number;
      };
      contextWindow?: number;
      supportsStructuredOutputs?: boolean;
      structuredOutputMode?: "auto" | "native_json_schema" | "tool_emulated" | "tool_auto";
      requestTimeout?: number;
      activeProfile?: string;
    };
    lmStudio?: {
      model?: string;
    };
  };
}

interface ICapturedChatExchange {
  index: number;
  requestBody: Record<string, unknown> | null;
  responseBody: Record<string, unknown> | null;
  status: number | null;
  durationMs: number;
}

//#endregion Types

//#region Setup

const localBaseUrl: string = "http://localhost:2345";

let tempDir: string;
let originalHome: string;
let tempConfigPath: string;
let endpointReachable: boolean = false;
let artifactsRootDir: string;

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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-summarization-e2e-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons();

  const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
  tempConfigPath = path.join(tempConfigDir, "config.yaml");

  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, tempConfigPath);

  artifactsRootDir = path.join(originalHome, ".blackdogbot", "test-artifacts", "summarization-e2e");
  await fs.mkdir(artifactsRootDir, { recursive: true });

  endpointReachable = await isEndpointReachableAsync();
});

afterAll(async () => {
  process.env.HOME = originalHome;
  resetSingletons();
  await fs.rm(tempDir, { recursive: true, force: true });
});

//#endregion Setup

//#region Private helpers

function countApproxTokens(messages: ModelMessage[]): number {
  const text: string = JSON.stringify(messages);
  return Math.ceil(text.length / 4);
}

function buildHistoryForTargetTokens(targetTokens: number): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: "You are a helpful assistant.",
    },
  ];

  let iteration: number = 1;
  while (countApproxTokens(messages) < targetTokens && iteration <= 200) {
    const detailBlock: string = `Detail block ${iteration}: ` + "A".repeat(850);

    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Task ${iteration}: review migration plan. ${detailBlock}`,
        },
      ],
    });

    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `target-call-${iteration}`,
          toolName: "edit_file",
          input: {
            path: `src/services/target-service-${iteration}.ts`,
            reasoning: `Need to preserve backward compatibility for batch ${iteration}. ${detailBlock}`,
            change: `Apply validation updates and migration notes for batch ${iteration}. ${detailBlock}`,
          },
        },
      ],
    });

    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `target-call-${iteration}`,
          toolName: "edit_file",
          output: {
            type: "json",
            value: {
              ok: true,
              file: `src/services/target-service-${iteration}.ts`,
              summary: `Updated migration and validation handling for target service ${iteration}. ${detailBlock}`,
              migrationId: `target-mig-${iteration}`,
            },
          },
        },
      ],
    });

    iteration++;
  }

  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "All planned migrations were applied and verified.",
      },
    ],
  });

  return messages;
}

function buildSingleShotSummarizationSource(targetTokens: number): string {
  const targetChars: number = Math.max(4000, targetTokens * 4);
  const sections: string[] = [];

  let i: number = 1;
  while (sections.join("\n\n").length < targetChars && i <= 500) {
    sections.push(
      [
        `Step ${i}`,
        `Decision: keep source feed feed-${i % 7} and disable fallback feed-${(i + 3) % 11}.`,
        `Reasoning: previous retry chain produced repeated 404 errors and stale duplicates in channel chat-${i % 5}.`,
        `Action: wrote row id=row-${i} into table news_items with status=verified and priority=${(i % 3) + 1}.`,
        `Pending: verify event ev-${i} with cross-source check source-A/source-B before alert publication.`,
      ].join(" "),
    );
    i++;
  }

  return sections.join("\n\n");
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function createArtifactRunDirAsync(testName: string): Promise<string> {
  const stamp: string = new Date().toISOString().replace(/[:.]/g, "-");
  const dirName: string = `${stamp}-${toSlug(testName)}`;
  const runDir: string = path.join(artifactsRootDir, dirName);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

async function withChatCaptureAsync<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; exchanges: ICapturedChatExchange[] }> {
  const originalFetch: typeof fetch = globalThis.fetch;
  const exchanges: ICapturedChatExchange[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString: string = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    const isChatCompletionsRequest: boolean =
      urlString.includes(`${localBaseUrl}/v1/chat/completions`) &&
      init?.method === "POST";

    if (!isChatCompletionsRequest) {
      return originalFetch(input, init);
    }

    const index: number = exchanges.length;
    let requestBody: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        requestBody = null;
      }
    }

    const startedAt: number = Date.now();
    const response: Response = await originalFetch(input, init);
    const durationMs: number = Date.now() - startedAt;

    let responseBody: Record<string, unknown> | null = null;
    try {
      const clone: Response = response.clone();
      const parsed: unknown = await clone.json();
      if (parsed && typeof parsed === "object") {
        responseBody = parsed as Record<string, unknown>;
      }
    } catch {
      responseBody = null;
    }

    exchanges.push({
      index,
      requestBody,
      responseBody,
      status: response.status,
      durationMs,
    });

    return response;
  };

  try {
    const result: T = await operation();
    return { result, exchanges };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function writeCaptureArtifactsAsync(
  runDir: string,
  captureName: string,
  exchanges: ICapturedChatExchange[],
  metadata: Record<string, unknown>,
): Promise<void> {
  const captureDir: string = path.join(runDir, captureName);
  await fs.mkdir(captureDir, { recursive: true });

  for (const exchange of exchanges) {
    const prefix: string = `${String(exchange.index).padStart(3, "0")}`;
    await fs.writeFile(
      path.join(captureDir, `${prefix}-request.json`),
      JSON.stringify(exchange.requestBody, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(captureDir, `${prefix}-response.json`),
      JSON.stringify(exchange.responseBody, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(captureDir, `${prefix}-meta.json`),
      JSON.stringify(
        {
          index: exchange.index,
          status: exchange.status,
          durationMs: exchange.durationMs,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  await fs.writeFile(path.join(captureDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
}

async function initializeLocalOpenAiCompatibleAsync(): Promise<LanguageModel | null> {
  const rawConfigText: string = await fs.readFile(tempConfigPath, "utf-8");
  const rawConfig: IRawConfig = parseYaml(rawConfigText) as IRawConfig;

  const modelId: string | undefined =
    process.env.BLACKDOGBOT_LOCAL_OPENAI_MODEL ||
    rawConfig.ai?.openaiCompatible?.model ||
    rawConfig.ai?.lmStudio?.model;

  if (!modelId) {
    return null;
  }

  const mergedOpenAiCompatible = {
    ...(rawConfig.ai?.openaiCompatible ?? {}),
    baseUrl: localBaseUrl,
    apiKey: rawConfig.ai?.openaiCompatible?.apiKey ?? "local-key",
    model: modelId,
    rateLimits: {
      rpm: rawConfig.ai?.openaiCompatible?.rateLimits?.rpm ?? 120,
      tpm: rawConfig.ai?.openaiCompatible?.rateLimits?.tpm ?? 200000,
      maxConcurrent: rawConfig.ai?.openaiCompatible?.rateLimits?.maxConcurrent ?? 1,
    },
    supportsStructuredOutputs: true,
    structuredOutputMode: "native_json_schema",
    requestTimeout: 600000,
    activeProfile: "qwen3_5",
  } as const;

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

  return aiProviderService.getDefaultModel();
}

//#endregion Private helpers

//#region Tests

describe.sequential("Summarization compaction E2E", () => {
  it("should summarize ~20k context in a single request path without stalling", async () => {
    if (process.env.BLACKDOGBOT_RUN_SUMMARIZATION_E2E !== "1") {
      console.log("Skipping: set BLACKDOGBOT_RUN_SUMMARIZATION_E2E=1 to run slow live summarization E2E");
      return;
    }

    if (!endpointReachable) {
      console.log(`Skipping: local OpenAI-compatible endpoint is not reachable at ${localBaseUrl}`);
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      console.log("Skipping: could not resolve model id for local OpenAI-compatible endpoint");
      return;
    }

    const runDir: string = await createArtifactRunDirAsync("single-request-summarization");
    const sourceText: string = buildSingleShotSummarizationSource(20000);

    const startedAt: number = Date.now();
    const capture = await withChatCaptureAsync(async () => {
      return await generateTextWithRetryAsync({
        model,
        prompt:
          "/no_think\n" +
          "Summarize the provided context using this exact format:\n" +
          "1) Decisions (max 6 bullets)\n" +
          "2) Actions completed (max 6 bullets)\n" +
          "3) Pending tasks (max 6 bullets)\n" +
          "4) Critical identifiers (single line comma-separated IDs)\n" +
          "Rules: Keep only concrete facts, preserve IDs, avoid repetition, no speculation.\n\n" +
          `Context:\n${sourceText}`,
        retryOptions: {
          callType: "summarization",
          maxAttempts: 1,
          timeoutMs: 600000,
        },
      });
    });
    const elapsedMs: number = Date.now() - startedAt;

    await writeCaptureArtifactsAsync(
      runDir,
      "single-request",
      capture.exchanges,
      {
        mode: "single_request",
        elapsedMs,
        requestCount: capture.exchanges.length,
        sourceChars: sourceText.length,
        resultLength: capture.result.text.length,
      },
    );

    expect(capture.result.text.trim().length).toBeGreaterThan(0);
    expect(capture.result.text.toLowerCase()).not.toContain("<think>");
    expect(capture.result.text.toLowerCase()).not.toContain("</think>");

    for (const exchange of capture.exchanges) {
      const requestBody: Record<string, unknown> | null = exchange.requestBody;
      if (!requestBody) {
        continue;
      }
      expect(requestBody.reasoning_format).toBe("none");
      expect(requestBody.chat_template_kwargs).toBeDefined();
      expect((requestBody.chat_template_kwargs as Record<string, unknown>).enable_thinking).toBe(false);
    }
  }, 900000);

  it("should compact medium history around 20k tokens without think tags", async () => {
    if (process.env.BLACKDOGBOT_RUN_SUMMARIZATION_E2E !== "1") {
      console.log("Skipping: set BLACKDOGBOT_RUN_SUMMARIZATION_E2E=1 to run slow live summarization E2E");
      return;
    }

    if (!endpointReachable) {
      console.log(`Skipping: local OpenAI-compatible endpoint is not reachable at ${localBaseUrl}`);
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      console.log("Skipping: could not resolve model id for local OpenAI-compatible endpoint");
      return;
    }

    const history: ModelMessage[] = buildHistoryForTargetTokens(20000);
    const originalMessagesCount: number = history.length;
    const originalTokens: number = countApproxTokens(history);
    const targetTokens: number = Math.max(12000, Math.floor(originalTokens * 0.7));

    expect(originalTokens).toBeGreaterThanOrEqual(18000);
    expect(originalTokens).toBeLessThanOrEqual(26000);

    const loggerService: LoggerService = LoggerService.getInstance();
    const result = await compactMessagesSummaryOnlyAsync(
      history,
      model,
      loggerService,
      targetTokens,
      countApproxTokens,
    );

    expect(result.messages.length).toBeLessThanOrEqual(originalMessagesCount);
    expect(result.compactedTokens).toBeLessThanOrEqual(result.originalTokens);

    const resultText: string = JSON.stringify(result.messages);
    expect(resultText.toLowerCase()).not.toContain("<think>");
    expect(resultText.toLowerCase()).not.toContain("</think>");
  }, 900000);
});

//#endregion Tests
