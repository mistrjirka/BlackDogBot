import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddingService } from "../../src/services/embedding.service.js";

//#region Helpers

function resetEmbeddingSingleton(): void {
  (EmbeddingService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("EmbeddingService (OpenRouter provider)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetEmbeddingSingleton();
  });

  it("should initialize and embed via OpenRouter embeddings API", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.3, 0.2, 0.1] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { embedding: [1, 0, 0] },
              { embedding: [0, 1, 0] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const service: EmbeddingService = EmbeddingService.getInstance();

    await service.initializeAsync(
      "Xenova/gte-multilingual-base",
      "q8",
      "cpu",
      "openrouter",
      "https://openrouter.ai/nvidia/llama-nemotron-embed-vl-1b-v2:free",
      "test-or-key",
    );

    const single: number[] = await service.embedAsync("hello");
    const batch: number[][] = await service.embedBatchAsync(["a", "b"]);

    expect(service.getModelPath()).toBe("nvidia/llama-nemotron-embed-vl-1b-v2:free");
    expect(service.getDimension()).toBe(3);
    expect(single).toEqual([0.3, 0.2, 0.1]);
    expect(batch).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-or-key",
        }),
      }),
    );
  });

  it("should throw when OpenRouter provider has no API key", async () => {
    const service: EmbeddingService = EmbeddingService.getInstance();

    await expect(
      service.initializeAsync(
        "Xenova/gte-multilingual-base",
        "q8",
        "cpu",
        "openrouter",
        "nvidia/llama-nemotron-embed-vl-1b-v2:free",
        "",
      ),
    ).rejects.toThrow("requires an API key");
  });
});

//#endregion Tests
