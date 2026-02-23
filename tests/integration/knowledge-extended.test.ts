import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { KnowledgeService } from "../../src/services/knowledge.service.js";
import { EmbeddingService } from "../../src/services/embedding.service.js";
import { VectorStoreService } from "../../src/services/vector-store.service.js";
import { LoggerService } from "../../src/services/logger.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (KnowledgeService as unknown as { _instance: null })._instance = null;
  (EmbeddingService as unknown as { _instance: null })._instance = null;
  (VectorStoreService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("KnowledgeService extended", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-knowledge-ext-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const embeddingService: EmbeddingService = EmbeddingService.getInstance();

    await embeddingService.initializeAsync();

    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.initializeAsync(path.join(tempDir, "lancedb"));
  }, 300000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should delete a document and not find it in search", async () => {
    const service: KnowledgeService = KnowledgeService.getInstance();

    // Add a document
    const doc = await service.addDocumentAsync(
      "This document will be deleted shortly",
      "delete-test",
    );

    expect(doc.id).toBeTruthy();

    // Delete it
    await service.deleteDocumentAsync(doc.id);

    // Search should not find it
    const results = await service.searchAsync({
      query: "document will be deleted",
      limit: 5,
      collection: "delete-test",
      filter: null,
    });

    const found = results.find((r) => r.id === doc.id);

    expect(found).toBeUndefined();
  });

  it("should count documents in a collection", async () => {
    const service: KnowledgeService = KnowledgeService.getInstance();

    // Add two documents to a specific collection
    await service.addDocumentAsync("Count doc one", "count-test");
    await service.addDocumentAsync("Count doc two", "count-test");

    const count: number = await service.getDocumentCountAsync("count-test");

    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("should return 0 count for an empty collection", async () => {
    const service: KnowledgeService = KnowledgeService.getInstance();

    const count: number = await service.getDocumentCountAsync("nonexistent-collection-xyz");

    expect(count).toBe(0);
  });
});

//#endregion Tests
