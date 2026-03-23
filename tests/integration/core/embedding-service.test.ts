import { describe, it, expect } from "vitest";

import { EmbeddingService } from "../../../src/services/embedding.service.js";

//#region Tests

describe("EmbeddingService", () => {
  it("should initialize with default model and generate embeddings", async () => {
    const service: EmbeddingService = EmbeddingService.getInstance();

    await service.initializeAsync();

    const embedding: number[] = await service.embedAsync("Hello, world!");

    expect(embedding).toBeDefined();
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBe(service.getDimension());
    expect(service.getModelPath().length).toBeGreaterThan(0);
    expect(typeof embedding[0]).toBe("number");
  }, 600000); // Model download can be slow

  it("should produce similar embeddings for similar texts", async () => {
    const service: EmbeddingService = EmbeddingService.getInstance();

    // Service should already be initialized from previous test,
    // but just in case tests run in isolation:
    await service.initializeAsync();

    const embedding1: number[] = await service.embedAsync("The cat sat on the mat");
    const embedding2: number[] = await service.embedAsync("A cat was sitting on a mat");
    const embedding3: number[] = await service.embedAsync("Quantum computing uses qubits");

    // Cosine similarity helper
    const cosineSimilarity = (a: number[], b: number[]): number => {
      let dotProduct: number = 0;
      let normA: number = 0;
      let normB: number = 0;

      for (let i: number = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }

      return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    const similarScore: number = cosineSimilarity(embedding1, embedding2);
    const dissimilarScore: number = cosineSimilarity(embedding1, embedding3);

    // Similar sentences should have higher similarity than dissimilar ones
    expect(similarScore).toBeGreaterThan(dissimilarScore);
    expect(similarScore).toBeGreaterThan(0.8);
  }, 600000);
});

//#endregion Tests
