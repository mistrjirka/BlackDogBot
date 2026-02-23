import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../src/services/config.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { EmbeddingService } from "../../src/services/embedding.service.js";
import { VectorStoreService } from "../../src/services/vector-store.service.js";
import { KnowledgeService } from "../../src/services/knowledge.service.js";
import type { IKnowledgeDocument, IKnowledgeSearchResult } from "../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (EmbeddingService as unknown as { _instance: null })._instance = null;
  (VectorStoreService as unknown as { _instance: null })._instance = null;
  (KnowledgeService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("Knowledge E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-knowledge-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Create config dir
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");

    await fs.mkdir(tempConfigDir, { recursive: true });

    // Initialize services
    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const embeddingService: EmbeddingService = EmbeddingService.getInstance();

    await embeddingService.initializeAsync();

    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
    const lanceDbPath: string = path.join(tempDir, ".betterclaw", "knowledge", "lancedb");

    await vectorStoreService.initializeAsync(lanceDbPath);
  }, 300000);

  afterAll(async () => {
    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.closeAsync();

    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should add a knowledge document and retrieve it by search", async () => {
    const knowledgeService: KnowledgeService = KnowledgeService.getInstance();

    const doc: IKnowledgeDocument = await knowledgeService.addDocumentAsync(
      "TypeScript is a strongly typed programming language that builds on JavaScript.",
      "test-collection",
      { source: "e2e-test" },
    );

    expect(doc).toBeDefined();
    expect(doc.id).toBeDefined();
    expect(doc.content).toContain("TypeScript");
    expect(doc.collection).toBe("test-collection");
    expect(doc.metadata.source).toBe("e2e-test");

    // Search for the document
    const results: IKnowledgeSearchResult[] = await knowledgeService.searchAsync({
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
    const knowledgeService: KnowledgeService = KnowledgeService.getInstance();

    await knowledgeService.addDocumentAsync(
      "Python is a high-level general purpose programming language known for its readability.",
      "test-collection",
      { source: "e2e-test" },
    );

    await knowledgeService.addDocumentAsync(
      "Rust is a systems programming language focused on safety and performance.",
      "test-collection",
      { source: "e2e-test" },
    );

    await knowledgeService.addDocumentAsync(
      "The best recipe for chocolate cake requires cocoa powder and butter.",
      "test-collection",
      { source: "e2e-test" },
    );

    // Search for programming language — should rank TS/Python/Rust higher than cake recipe
    const results: IKnowledgeSearchResult[] = await knowledgeService.searchAsync({
      query: "programming languages and type safety",
      collection: "test-collection",
      limit: 5,
      filter: null,
    });

    expect(results.length).toBeGreaterThanOrEqual(3);

    // The cake recipe should not be in the top results (or at least have lower score)
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
    const knowledgeService: KnowledgeService = KnowledgeService.getInstance();

    const doc: IKnowledgeDocument = await knowledgeService.addDocumentAsync(
      "Original content about databases.",
      "edit-test-collection",
      { version: 1 },
    );

    await knowledgeService.editDocumentAsync(
      doc.id,
      "edit-test-collection",
      "Updated content about vector databases and embeddings for semantic search.",
      { version: 2 },
    );

    const results: IKnowledgeSearchResult[] = await knowledgeService.searchAsync({
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
    const knowledgeService: KnowledgeService = KnowledgeService.getInstance();
    const count: number = await knowledgeService.getDocumentCountAsync("test-collection");

    // We added 4 documents to test-collection (1 TypeScript, 1 Python, 1 Rust, 1 cake)
    expect(count).toBe(4);
  });
});

//#endregion Tests
