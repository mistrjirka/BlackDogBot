import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as knowledge from "../../../src/helpers/knowledge.js";
import { EmbeddingService } from "../../../src/services/embedding.service.js";
import { VectorStoreService } from "../../../src/services/vector-store.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";

// Fixed vectors test persistence, distance ordering, and collection filtering.
// Language-model relevance remains covered by knowledge.e2e.test.ts.
const vectors: Record<string, number[]> = {
  "document alpha": [1, 0, 0],
  "document beta": [0, 1, 0],
  "document gamma": [0, 0, 1],
  "alpha updated": [0, 0, 1],
  "query alpha": [1, 0, 0],
  "query gamma": [0, 0, 1],
};
let dataDir: string;
let previousDataDir: string | undefined;
let modelInitialization: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-knowledge-offline-"));
  previousDataDir = process.env.BLACKDOGBOT_DATA_DIR;
  vi.stubEnv("BLACKDOGBOT_DATA_DIR", dataDir);
  resetSingletons([EmbeddingService, VectorStoreService]);
  const embeddings = EmbeddingService.getInstance();
  modelInitialization = vi.spyOn(embeddings, "initializeAsync").mockImplementation(async () => {
    throw new Error("The fast knowledge suite must not initialize or download a model.");
  });
  vi.spyOn(embeddings, "embedAsync").mockImplementation(async text => {
    const vector = vectors[text];
    if (!vector) throw new Error("Unknown test embedding input.");
    return [...vector];
  });
  await VectorStoreService.getInstance().initializeAsync(path.join(dataDir, "knowledge", "lancedb"), 3);
});

afterEach(async () => {
  expect(modelInitialization).not.toHaveBeenCalled();
  await VectorStoreService.getInstance().closeAsync();
  vi.restoreAllMocks();
  vi.stubEnv("BLACKDOGBOT_DATA_DIR", previousDataDir);
  resetSingletons([EmbeddingService, VectorStoreService]);
  await fs.rm(dataDir, { recursive: true, force: true });
});

function search(query: string, collection = "first", limit = 5) {
  return knowledge.searchKnowledgeAsync({ query, collection, limit, filter: null });
}

describe("Knowledge persistence without model downloads", () => {
  it("stores content and metadata and returns the nearest stored vector", async () => {
    const metadata = { source: "fixture", nested: { revision: 1 } };
    const doc = await knowledge.addKnowledgeDocumentAsync("document alpha", "first", metadata);
    await knowledge.addKnowledgeDocumentAsync("document beta", "first", { source: "other" });

    const results = await search("query alpha");
    expect(results.map(result => result.id)[0]).toBe(doc.id);
    expect(results[0]).toMatchObject({ content: "document alpha", collection: "first", metadata });
    expect(results[0].score).toBeCloseTo(1);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("keeps collection filtering and result limits independent of nearest neighbors", async () => {
    const visible = await knowledge.addKnowledgeDocumentAsync("document beta", "first");
    await knowledge.addKnowledgeDocumentAsync("document alpha", "second");
    await knowledge.addKnowledgeDocumentAsync("document gamma", "first");

    const results = await search("query alpha", "first", 1);
    expect(results).toHaveLength(1);
    expect(results[0].collection).toBe("first");
    const ids = (await search("query alpha")).map(result => result.id);
    expect(ids).toContain(visible.id);
    expect(await knowledge.getKnowledgeDocumentCountAsync("first")).toBe(2);
    expect(await knowledge.getKnowledgeDocumentCountAsync("second")).toBe(1);
  });

  it("updates text, metadata, and vector together while preserving the record ID", async () => {
    const doc = await knowledge.addKnowledgeDocumentAsync("document alpha", "first", { revision: 1 });
    await knowledge.addKnowledgeDocumentAsync("document beta", "first");
    await knowledge.editKnowledgeDocumentAsync(doc.id, "first", "alpha updated", { revision: 2 });

    const results = await search("query gamma");
    expect(results[0]).toMatchObject({ id: doc.id, content: "alpha updated", metadata: { revision: 2 } });
    expect(results[0].score).toBeCloseTo(1);
    expect(await knowledge.getKnowledgeDocumentCountAsync("first")).toBe(2);
  });

  it("deletes only the selected document", async () => {
    const removed = await knowledge.addKnowledgeDocumentAsync("document alpha", "first");
    const kept = await knowledge.addKnowledgeDocumentAsync("document beta", "first");
    await knowledge.deleteKnowledgeDocumentAsync(removed.id);

    expect((await search("query alpha")).map(result => result.id)).toEqual([kept.id]);
    expect(await knowledge.getKnowledgeDocumentCountAsync("first")).toBe(1);
  });

  it("reads records after reopening the database without re-embedding them", async () => {
    const doc = await knowledge.addKnowledgeDocumentAsync("document gamma", "first", { persisted: true });
    const store = VectorStoreService.getInstance();
    await store.closeAsync();
    await store.initializeAsync(path.join(dataDir, "knowledge", "lancedb"), 3);

    expect((await search("query gamma"))[0]).toMatchObject({
      id: doc.id, content: "document gamma", metadata: { persisted: true },
    });
  });

  it("returns empty results and zero count for an empty collection", async () => {
    expect(await search("query alpha", "empty")).toEqual([]);
    expect(await knowledge.getKnowledgeDocumentCountAsync("empty")).toBe(0);
  });
});
