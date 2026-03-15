import { describe, it, expect, beforeEach } from "vitest";
import { compactToolResultAsync, estimateTokenCount } from "../../../src/utils/tool-result-compaction.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import path from "node:path";
import os from "node:os";
import { resetSingletons } from "../../utils/test-helpers.js";

describe("tool-result-compaction", () => {
  beforeEach(async () => {
    resetSingletons();
    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(os.tmpdir(), "test-logs"));
  });

  describe("estimateTokenCount", () => {
    it("should return 0 for null and undefined", () => {
      expect(estimateTokenCount(null)).toBe(0);
      expect(estimateTokenCount(undefined)).toBe(0);
    });

    it("should estimate tokens for strings", () => {
      const str = "Hello world"; // 11 chars / 4 = 2.75 -> ceil = 3
      expect(estimateTokenCount(str)).toBe(3);
    });

    it("should estimate tokens for objects", () => {
      const obj = { key: "value" }; // 15 chars / 4 = 3.75 -> ceil = 4
      expect(estimateTokenCount(obj)).toBe(4);
    });
  });

  describe("compactToolResultAsync", () => {
    it("should not compact small results", async () => {
      const smallResult = { id: 1, name: "test", count: 42 };
      
      const result = await compactToolResultAsync(smallResult, { maxTokens: 2000 });
      
      expect(result.wasCompacted).toBe(false);
      expect(result.value).toEqual(smallResult);
      expect(result.summarizedFields).toBe(0);
    });

    it("should preserve object shape", async () => {
      const largeResult = {
        id: 123,
        name: "Test Object",
        status: "active",
        timestamp: "2026-01-01T00:00:00Z",
        url: "https://example.com",
        largeField: "x".repeat(10000), // Large field
      };
      
      const result = await compactToolResultAsync(largeResult, { maxTokens: 1000 });
      
      expect(result.value).toHaveProperty("id");
      expect(result.value).toHaveProperty("name");
      expect(result.value).toHaveProperty("status");
      expect(result.value).toHaveProperty("timestamp");
      expect(result.value).toHaveProperty("url");
      expect(result.value).toHaveProperty("largeField");
    });

    it("should preserve identity fields", async () => {
      const result = {
        id: "abc-123",
        url: "https://example.com/doc",
        name: "Important Doc",
        largeData: "x".repeat(10000),
      };
      
      const compacted = await compactToolResultAsync(result, { maxTokens: 1000 });
      
      const value = compacted.value as Record<string, unknown>;
      expect(value.id).toBe("abc-123");
      expect(value.url).toBe("https://example.com/doc");
      expect(value.name).toBe("Important Doc");
    });

    it("should compact large arrays to representative items", async () => {
      const result = {
        items: Array.from({ length: 100 }, (_, i) => ({ id: i, data: `item ${i}` })),
        metadata: { count: 100 },
      };
      
      const compacted = await compactToolResultAsync(result, { maxTokens: 500, representativeArraySize: 3 });
      
      const value = compacted.value as Record<string, unknown>;
      expect(Array.isArray(value.items)).toBe(true);
      expect((value.items as unknown[]).length).toBeLessThanOrEqual(3);
      expect(value.metadata).toBeDefined();
    });

    it("should handle already summarized fields", async () => {
      const result = {
        id: 1,
        summary: "[COMPACTION_SUMMARY] Previously summarized content",
        data: "x".repeat(10000),
      };
      
      const compacted = await compactToolResultAsync(result, { maxTokens: 1000 });
      
      const value = compacted.value as Record<string, unknown>;
      expect(value.summary).toBe("[COMPACTION_SUMMARY] Previously summarized content");
    });

    it("should track summarized field count", async () => {
      const result = {
        field1: "x".repeat(5000),
        field2: "y".repeat(5000),
        field3: "z".repeat(5000),
      };
      
      const compacted = await compactToolResultAsync(result, { maxTokens: 1000 });
      
      expect(compacted.summarizedFields).toBeGreaterThan(0);
      expect(compacted.originalTokens).toBeGreaterThan(compacted.compactedTokens);
    });
  });
});