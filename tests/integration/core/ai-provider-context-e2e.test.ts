import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { IAiConfig } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;


//#region Tests

describe("AiProviderService - Token-gated fetch E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-ai-provider-context-e2e-"));
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

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should allow requests under the hard limit", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    const model = service.getDefaultModel();

    const modelFetch = (model as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch;

    if (!modelFetch) {
      throw new Error("Model does not have a fetch function configured");
    }

    const smallRequestBody: string = JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    });

    const response: Response = await modelFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: smallRequestBody,
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).not.toBe(400);
  }, 600000);

  it("should reject requests exceeding the hard limit with 400 error", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    const model = service.getDefaultModel();

    const modelFetch = (model as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch;

    if (!modelFetch) {
      throw new Error("Model does not have a fetch function configured");
    }

    const largeContent: string = "This is a test message. ".repeat(10_000);
    const largeRequestBody: string = JSON.stringify({
      messages: [
        { role: "user", content: largeContent },
        { role: "assistant", content: largeContent },
        { role: "user", content: largeContent },
      ],
    });

    const response: Response = await modelFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: largeRequestBody,
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const errorBody = await response.json();
    expect(errorBody).toHaveProperty("error");
    expect(errorBody.error).toHaveProperty("type", "context_length_exceeded");
    expect(errorBody.error).toHaveProperty("code", "context_length_exceeded");
    expect(errorBody.error.message).toMatch(/Context size exceeded/i);
    expect(errorBody.error.message).toMatch(/hard limit/i);
  }, 600000);

  it("should only gate POST requests with body", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    const model = service.getDefaultModel();

    const modelFetch = (model as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch;

    if (!modelFetch) {
      throw new Error("Model does not have a fetch function configured");
    }

    const response: Response = await modelFetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
    });

    expect(response.status).not.toBe(400);
  }, 600000);
});

//#endregion Tests
