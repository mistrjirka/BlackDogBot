import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createTestEnvironment, setupVectorStoreAsync } from "../../utils/test-helpers.js";
import * as knowledge from "../../../src/helpers/knowledge.js";
import type { IKnowledgeDocument, IKnowledgeSearchResult } from "../../../src/shared/types/index.js";
import { VectorStoreService } from "../../../src/services/vector-store.service.js";

const env = createTestEnvironment("knowledge");

describe("KnowledgeService", () => {
  beforeAll(async () => {
    await env.setupAsync();
    await setupVectorStoreAsync();
  }, 300000);

  afterAll(async () => {
    const vectorStoreService = VectorStoreService.getInstance();
    await vectorStoreService.closeAsync();
    await env.teardownAsync();
  });

  it("should add a knowledge document and retrieve it by search", async () => {
    const doc: IKnowledgeDocument = await knowledge.addKnowledgeDocumentAsync(
      "TypeScript is a strongly typed programming language that builds on JavaScript.",
      "test-collection",
      { source: "e2e-test" },
    );

    expect(doc).toBeDefined();
    expect(doc.id).toBeDefined();
    expect(doc.content).toContain("TypeScript");
    expect(doc.collection).toBe("test-collection");
    expect(doc.metadata.source).toBe("e2e-test");

    const results: IKnowledgeSearchResult[] = await knowledge.searchKnowledgeAsync({
      query: "What is TypeScript?",
      collection: "test-collection",
      limit: 5,
      filter: null,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("TypeScript");
    expect(results[0].score).toBeGreaterThan(0.5);
  }, 60000);

  it("should return relevant results when multiple documents exist", async () => {
    await knowledge.addKnowledgeDocumentAsync(
      "Python is a high-level general purpose programming language known for its readability.",
      "test-collection",
      { source: "e2e-test" },
    );

    await knowledge.addKnowledgeDocumentAsync(
      "Rust is a systems programming language focused on safety and performance.",
      "test-collection",
      { source: "e2e-test" },
    );

    await knowledge.addKnowledgeDocumentAsync(
      "The best recipe for chocolate cake requires cocoa powder and butter.",
      "test-collection",
      { source: "e2e-test" },
    );

    const results: IKnowledgeSearchResult[] = await knowledge.searchKnowledgeAsync({
      query: "programming languages and type safety",
      collection: "test-collection",
      limit: 5,
      filter: null,
    });

    expect(results.length).toBeGreaterThanOrEqual(3);

    const cakeResult: IKnowledgeSearchResult | undefined = results.find(
      (r: IKnowledgeSearchResult) => r.content.includes("chocolate cake"),
    );
    const programmingResult: IKnowledgeSearchResult = results[0];

    expect(programmingResult.content).not.toContain("chocolate cake");

    if (cakeResult) {
      expect(cakeResult.score).toBeLessThan(programmingResult.score);
    }
  }, 60000);

  it("should edit a knowledge document and find updated content", async () => {
    const doc: IKnowledgeDocument = await knowledge.addKnowledgeDocumentAsync(
      "Original content about databases.",
      "edit-test-collection",
      { version: 1 },
    );

    await knowledge.editKnowledgeDocumentAsync(
      doc.id,
      "edit-test-collection",
      "Updated content about vector databases and embeddings for semantic search.",
      { version: 2 },
    );

    const results: IKnowledgeSearchResult[] = await knowledge.searchKnowledgeAsync({
      query: "vector databases semantic search",
      collection: "edit-test-collection",
      limit: 5,
      filter: null,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("vector databases");
    expect(results[0].content).toContain("semantic search");
  }, 60000);

  it("should report correct document counts", async () => {
    const count: number = await knowledge.getKnowledgeDocumentCountAsync("test-collection");

    expect(count).toBe(4);
  });

  it("should delete a document and not find it in search", async () => {
    const doc = await knowledge.addKnowledgeDocumentAsync(
      "This document will be deleted shortly",
      "delete-test",
    );

    expect(doc.id).toBeTruthy();

    await knowledge.deleteKnowledgeDocumentAsync(doc.id);

    const results = await knowledge.searchKnowledgeAsync({
      query: "document will be deleted",
      limit: 5,
      collection: "delete-test",
      filter: null,
    });

    const found = results.find((r) => r.id === doc.id);

    expect(found).toBeUndefined();
  });

  it("should return 0 count for an empty collection", async () => {
    const count: number = await knowledge.getKnowledgeDocumentCountAsync("nonexistent-collection-xyz");

    expect(count).toBe(0);
  });
});
