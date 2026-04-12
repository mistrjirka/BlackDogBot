import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddingService } from "../../src/services/embedding.service.js";
import { DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL } from "../../src/shared/constants.js";
import { env } from "@huggingface/transformers";

//#region Helpers

function resetEmbeddingSingleton(): void {
  (EmbeddingService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("EmbeddingService (local fallback)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetEmbeddingSingleton();
  });

  it("should fall back to the compatible local model when cache reset retry still protobuf-fails", async () => {
    const service: EmbeddingService = EmbeddingService.getInstance();
    let loadCallCount: number = 0;

    vi.spyOn(service as unknown as { _clearModelCacheAsync(): Promise<void> }, "_clearModelCacheAsync").mockResolvedValue(undefined);

    vi
      .spyOn(service as unknown as { _loadPipelineAsync(): Promise<void> }, "_loadPipelineAsync")
      .mockImplementation(async (): Promise<void> => {
        loadCallCount += 1;

        if (loadCallCount <= 2) {
          throw new Error("Load model from /tmp/onnx/model_quantized.onnx failed:Protobuf parsing failed.");
        }

        (service as unknown as { _pipeline: unknown })._pipeline = (async (): Promise<{ tolist(): number[][] }> => ({
          tolist: (): number[][] => [[0.1, 0.2, 0.3]],
        })) as unknown;
      });

    await service.initializeAsync();

    expect(loadCallCount).toBe(3);
    expect(service.getModelPath()).toBe(DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL);
    expect(service.getDimension()).toBe(3);
  });

  it("configures ONNX executionProviders to cpu for local cpu device", async () => {
    const service: EmbeddingService = EmbeddingService.getInstance();
    (env as unknown as { backends?: unknown }).backends = undefined;

    vi.spyOn(service as unknown as { _resolveDeviceAsync(device: unknown): Promise<"cpu" | "cuda"> }, "_resolveDeviceAsync")
      .mockResolvedValue("cpu");
    vi.spyOn(service as unknown as { _loadPipelineAsync(): Promise<void> }, "_loadPipelineAsync")
      .mockImplementation(async (): Promise<void> => {
        (service as unknown as { _pipeline: unknown })._pipeline = (async (): Promise<{ tolist(): number[][] }> => ({
          tolist: (): number[][] => [[0.1, 0.2, 0.3]],
        })) as unknown;
      });

    await service.initializeAsync(undefined, undefined, "cpu", "local");

    const configuredBackends = (env as unknown as { backends?: { onnx?: { executionProviders?: string[] } } }).backends;
    expect(configuredBackends).toBeDefined();
    expect(configuredBackends?.onnx).toBeDefined();
    expect(configuredBackends?.onnx?.executionProviders).toEqual(["cpu"]);
  });
});

//#endregion Tests
