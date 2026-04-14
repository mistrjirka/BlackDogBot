import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LanguageModel, ModelMessage } from "ai";

import { resetSingletons } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { compactMessagesSummaryOnlyAsync } from "../../../src/utils/summarization-compaction.js";

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
      requestTimeout?: number;
      supportsStructuredOutputs?: boolean;
      structuredOutputMode?: "auto" | "native_json_schema" | "tool_emulated" | "tool_auto";
      activeProfile?: string;
    };
    lmStudio?: {
      model?: string;
    };
  };
}

const localBaseUrl: string = "http://localhost:2345";

let tempDir: string;
let originalHome: string;
let tempConfigPath: string;
let endpointReachable: boolean = false;

function countApprox(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function makeToolMessage(toolCallId: string, text: string): ModelMessage {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId,
      output: { type: "text", value: text },
    }],
  } as ModelMessage;
}

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
    requestTimeout: 600000,
    supportsStructuredOutputs: true,
    structuredOutputMode: "native_json_schema",
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

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-dag-e2e-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  resetSingletons();

  const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
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

describe.sequential("Summarization DAG compaction E2E", () => {
  it("uses L1 as first node for standard multi-message history", async () => {
    if (!endpointReachable) {
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      return;
    }

    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      { role: "user", content: "Old request " + "A".repeat(3200) } as ModelMessage,
      { role: "assistant", content: [{ type: "text", text: "running" }] } as ModelMessage,
      makeToolMessage("t1", "tool output " + "X".repeat(5200)),
      { role: "user", content: "LATEST USER: process newest request" } as ModelMessage,
      makeToolMessage("t2", "latest tool output " + "Y".repeat(4200)),
    ];

    const target: number = Math.floor(countApprox(messages) * 0.22);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      model,
      LoggerService.getInstance(),
      target,
      countApprox,
      true,
    );

    expect(result.dagPath && result.dagPath.length > 0).toBe(true);
    expect(result.dagPath?.[0]).toBe("L1");
  }, 900000);

  it("uses L2 first when history has only system + oversized tool result", async () => {
    if (!endpointReachable) {
      return;
    }

    const model: LanguageModel | null = await initializeLocalOpenAiCompatibleAsync();
    if (!model) {
      return;
    }

    const messages: ModelMessage[] = [
      { role: "system", content: "System anchor" } as ModelMessage,
      makeToolMessage("oversized", "very large single tool result " + "Z".repeat(18000)),
    ];

    const target: number = Math.floor(countApprox(messages) * 0.30);
    const result = await compactMessagesSummaryOnlyAsync(
      messages,
      model,
      LoggerService.getInstance(),
      target,
      countApprox,
      true,
    );

    expect(result.dagPath && result.dagPath.length > 0).toBe(true);
    expect(result.dagPath?.[0]).toBe("L2");
  }, 900000);
});
