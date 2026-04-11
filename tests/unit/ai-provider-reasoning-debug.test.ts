import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { resetSingletons } from "../utils/test-helpers.js";

//#region Tests

describe("AiProviderService reasoning diagnostics", () => {
  beforeEach(() => {
    resetSingletons();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSingletons();
  });

  it("logs when think tags are present in assistant content", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    (service as unknown as { _llmResponseDiagnosticsEnabled: boolean })._llmResponseDiagnosticsEnabled = true;
    const loggerService: LoggerService = LoggerService.getInstance();
    const debugSpy = vi.spyOn(loggerService, "debug").mockImplementation((): void => {});

    const response: Response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "<think>first step</think>Done.",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

    await (service as unknown as {
      _fixReasoningContentResponse(input: Response): Promise<Response>;
    })._fixReasoningContentResponse(response);

    expect(debugSpy).toHaveBeenCalledWith(
      "Detected think tags in LLM response",
      expect.objectContaining({
        hasToolCalls: false,
        thinkTagCount: 1,
      }),
    );
  });

  it("logs when reasoning_content exists without visible content", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    (service as unknown as { _llmResponseDiagnosticsEnabled: boolean })._llmResponseDiagnosticsEnabled = true;
    const loggerService: LoggerService = LoggerService.getInstance();
    const debugSpy = vi.spyOn(loggerService, "debug").mockImplementation((): void => {});

    const response: Response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "internal reasoning",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

    await (service as unknown as {
      _fixReasoningContentResponse(input: Response): Promise<Response>;
    })._fixReasoningContentResponse(response);

    expect(debugSpy).toHaveBeenCalledWith(
      "Detected reasoning_content without visible content in LLM response",
      expect.objectContaining({
        hasToolCalls: false,
      }),
    );
  });

  it("does not emit diagnostics when feature flag is disabled", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    (service as unknown as { _llmResponseDiagnosticsEnabled: boolean })._llmResponseDiagnosticsEnabled = false;
    const loggerService: LoggerService = LoggerService.getInstance();
    const debugSpy = vi.spyOn(loggerService, "debug").mockImplementation((): void => {});

    const response: Response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "<think>hidden thought</think>answer",
              reasoning_content: "hidden thought",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

    await (service as unknown as {
      _fixReasoningContentResponse(input: Response): Promise<Response>;
    })._fixReasoningContentResponse(response);

    expect(debugSpy).not.toHaveBeenCalledWith(
      "Detected think tags in LLM response",
      expect.anything(),
    );
    expect(debugSpy).not.toHaveBeenCalledWith(
      "Detected reasoning_content without visible content in LLM response",
      expect.anything(),
    );
  });

  it("emits info log when reasoning is detected even if diagnostics flag is disabled", async () => {
    const service: AiProviderService = AiProviderService.getInstance();
    (service as unknown as { _llmResponseDiagnosticsEnabled: boolean })._llmResponseDiagnosticsEnabled = false;
    const loggerService: LoggerService = LoggerService.getInstance();
    const infoSpy = vi.spyOn(loggerService, "info").mockImplementation((): void => {});

    const response: Response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "<think>hidden thought</think>answer",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

    await (service as unknown as {
      _fixReasoningContentResponse(input: Response): Promise<Response>;
    })._fixReasoningContentResponse(response);

    expect(infoSpy).toHaveBeenCalledWith(
      "Detected reasoning in LLM response",
      expect.objectContaining({
        choicesWithReasoning: 1,
        choicesWithThinkTags: 1,
      }),
    );
  });
});

//#endregion Tests
