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
import { getSafeTimestamp } from "../../../src/utils/timestamp.js";

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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-compaction-e2e-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons();

  const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
  tempConfigPath = path.join(tempConfigDir, "config.yaml");

  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, tempConfigPath);

  artifactsRootDir = path.join(originalHome, ".blackdogbot", "test-artifacts", "compaction-e2e");
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

function buildLargePrefixConversation(targetTokens: number): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: "You are a helpful assistant.",
    },
  ];

  // Build large prefix with many messages
  let iteration: number = 1;
  while (countApproxTokens(messages) < targetTokens * 0.7 && iteration <= 300) {
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
          toolCallId: `call-${iteration}`,
          toolName: "edit_file",
          input: {
            path: `src/services/service-${iteration}.ts`,
            reasoning: `Need to preserve backward compatibility for batch ${iteration}. ${detailBlock}`,
            change: `Apply validation updates for batch ${iteration}. ${detailBlock}`,
          },
        },
      ],
    });

    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${iteration}`,
          toolName: "edit_file",
          output: {
            type: "json",
            value: {
              ok: true,
              file: `src/services/service-${iteration}.ts`,
              summary: `Updated migration handling for service ${iteration}. ${detailBlock}`,
              migrationId: `mig-${iteration}`,
            },
          },
        },
      ],
    });

    iteration++;
  }

  // Latest user message (should be preserved)
  messages.push({
    role: "user",
    content: "LATEST USER: perform operation with id ABC123 and url https://example.com",
  });

  // Some messages after latest user
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "running tools" }],
  });
  messages.push({
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "latest-call",
      toolName: "edit_file",
      output: {
        type: "json",
        value: { ok: true, file: "src/services/latest.ts", summary: "Latest tool output" },
      },
    }],
  });

  return messages;
}

function buildConversationForBatchedCompaction(): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "system", content: "System anchor" } as ModelMessage,
  ];

  // Add many messages that should be batched
  for (let i: number = 0; i < 30; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: ${"X".repeat(1500)}`,
    } as ModelMessage);
  }

  // Latest user message
  messages.push({
    role: "user",
    content: "LATEST USER: continue with id XYZ789",
  } as ModelMessage);

  return messages;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function createArtifactRunDirAsync(testName: string): Promise<string> {
  const stamp: string = getSafeTimestamp();
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

describe.sequential("Compaction DAG E2E - new features", () => {
  // Task 10.1: Chunked compaction with ~55k token prefix
  it("should compact large ~55k token prefix using chunked summarization", async () => {
    if (!endpointReachable) {
      console.log(`Skipping: local OpenAI-compatible endpoint is not reachable at ${localBaseUrl}`);
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      console.log("Skipping: could not resolve model id for local OpenAI-compatible endpoint");
      return;
    }

    const runDir: string = await createArtifactRunDirAsync("chunked-compaction-55k");
    const history: ModelMessage[] = buildLargePrefixConversation(55000);
    const originalTokens: number = countApproxTokens(history);
    const targetTokens: number = Math.max(12000, Math.floor(originalTokens * 0.35));

    console.log(`Chunked compaction: original tokens ~${originalTokens}, target ~${targetTokens}`);

    const loggerService: LoggerService = LoggerService.getInstance();
    const capture = await withChatCaptureAsync(async () => {
      return await compactMessagesSummaryOnlyAsync(
        history,
        model,
        loggerService,
        targetTokens,
        countApproxTokens,
        true,
        {
          contextWindow: 128000,
        },
      );
    });

    await writeCaptureArtifactsAsync(
      runDir,
      "chunked-compaction",
      capture.exchanges,
      {
        mode: "chunked_compaction",
        originalTokens,
        targetTokens,
        compactedTokens: capture.result.compactedTokens,
        passes: capture.result.passes,
        dagPath: capture.result.dagPath,
        requestCount: capture.exchanges.length,
      },
    );

    // Should have reduced tokens
    expect(capture.result.compactedTokens).toBeLessThan(capture.result.originalTokens);
    // Should have used multiple LLM calls (chunked summarization)
    expect(capture.exchanges.length).toBeGreaterThan(1);
    // Should have visited DAG nodes
    expect(capture.result.dagPath?.length).toBeGreaterThan(0);
    // Should not contain think tags
    const resultText: string = JSON.stringify(capture.result.messages);
    expect(resultText.toLowerCase()).not.toContain("<think>");
    expect(resultText.toLowerCase()).not.toContain("</think>");
  }, 1800000); // 30 min - allows for circuit breaker (2 × 600s timeouts) + fallback

  // Task 10.2: DAG fallback when summarization hits hard gate
  it("should fallback to L3/L4 when summarization cannot converge", async () => {
    if (!endpointReachable) {
      console.log(`Skipping: local OpenAI-compatible endpoint is not reachable at ${localBaseUrl}`);
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      console.log("Skipping: could not resolve model id for local OpenAI-compatible endpoint");
      return;
    }

    const runDir: string = await createArtifactRunDirAsync("dag-fallback-l3-l4");
    const history: ModelMessage[] = buildLargePrefixConversation(40000);
    const originalTokens: number = countApproxTokens(history);
    // Set very aggressive target to force fallback
    const targetTokens: number = Math.max(5000, Math.floor(originalTokens * 0.15));

    console.log(`DAG fallback: original tokens ~${originalTokens}, aggressive target ~${targetTokens}`);

    const loggerService: LoggerService = LoggerService.getInstance();
    const capture = await withChatCaptureAsync(async () => {
      return await compactMessagesSummaryOnlyAsync(
        history,
        model,
        loggerService,
        targetTokens,
        countApproxTokens,
        true,
        {
          contextWindow: 128000,
        },
      );
    });

    await writeCaptureArtifactsAsync(
      runDir,
      "dag-fallback",
      capture.exchanges,
      {
        mode: "dag_fallback",
        originalTokens,
        targetTokens,
        compactedTokens: capture.result.compactedTokens,
        passes: capture.result.passes,
        dagPath: capture.result.dagPath,
        maxLevelReached: capture.result.maxLevelReached,
        requestCount: capture.exchanges.length,
      },
    );

    // Should have visited multiple DAG nodes
    expect(capture.result.dagPath?.length).toBeGreaterThan(1);
    // Should have reduced tokens significantly
    expect(capture.result.compactedTokens).toBeLessThan(capture.result.originalTokens);
    // Should have reached at least L2 or L3
    expect(capture.result.maxLevelReached).not.toBe("L1");
  }, 1800000); // 30 min - allows for circuit breaker

  // Task 10.3: Batched per-message summarization produces valid summaries
  it("should produce valid batched summaries for many messages", async () => {
    if (!endpointReachable) {
      console.log(`Skipping: local OpenAI-compatible endpoint is not reachable at ${localBaseUrl}`);
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      console.log("Skipping: could not resolve model id for local OpenAI-compatible endpoint");
      return;
    }

    const runDir: string = await createArtifactRunDirAsync("batched-summarization");
    const history: ModelMessage[] = buildConversationForBatchedCompaction();
    const originalTokens: number = countApproxTokens(history);
    const targetTokens: number = Math.max(5000, Math.floor(originalTokens * 0.25));

    console.log(`Batched summarization: original tokens ~${originalTokens}, target ~${targetTokens}`);

    const loggerService: LoggerService = LoggerService.getInstance();
    const capture = await withChatCaptureAsync(async () => {
      return await compactMessagesSummaryOnlyAsync(
        history,
        model,
        loggerService,
        targetTokens,
        countApproxTokens,
        true,
        {
          contextWindow: 128000,
        },
      );
    });

    await writeCaptureArtifactsAsync(
      runDir,
      "batched-summarization",
      capture.exchanges,
      {
        mode: "batched_summarization",
        originalTokens,
        targetTokens,
        compactedTokens: capture.result.compactedTokens,
        passes: capture.result.passes,
        dagPath: capture.result.dagPath,
        requestCount: capture.exchanges.length,
      },
    );

    // Should have reduced tokens
    expect(capture.result.compactedTokens).toBeLessThan(capture.result.originalTokens);
    // Should have used LLM calls
    expect(capture.exchanges.length).toBeGreaterThan(0);
    // Should have visited DAG nodes (L1 may converge, or L4 may be reached)
    expect(capture.result.dagPath?.length).toBeGreaterThan(0);
    // Should have at least one compaction pass
    expect(capture.result.passes).toBeGreaterThanOrEqual(1);
    // Should not contain think tags
    const resultText: string = JSON.stringify(capture.result.messages);
    expect(resultText.toLowerCase()).not.toContain("<think>");
    expect(resultText.toLowerCase()).not.toContain("</think>");
  }, 1800000); // 30 min - allows for circuit breaker
});

//#endregion Tests
