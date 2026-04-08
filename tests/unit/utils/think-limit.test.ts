import { describe, expect, it, beforeEach } from "vitest";
import { ThinkOperationTracker } from "../../../src/utils/think-limit.js";

describe("ThinkOperationTracker", () => {
  let tracker: ThinkOperationTracker;

  beforeEach(() => {
    tracker = new ThinkOperationTracker({
      maxThinkOperations: 5,
      maxTotalThinkCharacters: 1000,
    });
  });

  describe("recordThinkOperation", () => {
    it("should preserve short thought exactly without truncation", () => {
      const thought = "This is a short thought.";
      const result = tracker.recordThinkOperation(thought);

      expect(result.thought).toBe(thought);
      expect(result.wasTruncated).toBe(false);
    });

    it("should preserve long thought exactly without truncation marker", () => {
      const longThought = "A".repeat(5000);
      const result = tracker.recordThinkOperation(longThought);

      expect(result.thought).toBe(longThought);
      expect(result.wasTruncated).toBe(false);
      expect(result.thought).not.toContain("TRUNCATED");
    });

    it("should preserve thought with special characters exactly", () => {
      const thought = "Thought with émoji 😀 and\nnewline\tand 'quotes'";
      const result = tracker.recordThinkOperation(thought);

      expect(result.thought).toBe(thought);
      expect(result.wasTruncated).toBe(false);
    });

    it("should always return wasTruncated as false regardless of thought length", () => {
      const shortThought = "Short";
      const mediumThought = "B".repeat(1000);
      const longThought = "C".repeat(10000);

      const shortResult = tracker.recordThinkOperation(shortThought);
      const mediumResult = tracker.recordThinkOperation(mediumThought);
      const longResult = tracker.recordThinkOperation(longThought);

      expect(shortResult.wasTruncated).toBe(false);
      expect(mediumResult.wasTruncated).toBe(false);
      expect(longResult.wasTruncated).toBe(false);
    });

    it("should track think count correctly", () => {
      tracker.recordThinkOperation("First thought");
      tracker.recordThinkOperation("Second thought");
      tracker.recordThinkOperation("Third thought");

      const stats = tracker.getStats();
      expect(stats.thinkCount).toBe(3);
    });

    it("should track total characters correctly", () => {
      tracker.recordThinkOperation("Hello");
      tracker.recordThinkOperation("World");

      const stats = tracker.getStats();
      expect(stats.totalCharacters).toBe(10);
    });

    it("should report withinLimits correctly when under limits", () => {
      tracker.recordThinkOperation("Test");

      const stats = tracker.getStats();
      expect(stats.withinLimits).toBe(true);
    });

    it("should report withinLimits as false when over count limit", () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordThinkOperation(`Thought ${i}`);
      }
      tracker.recordThinkOperation("One more over the limit");

      const stats = tracker.getStats();
      expect(stats.withinLimits).toBe(false);
      expect(stats.thinkCount).toBe(6);
    });

    it("should report withinLimits as false when over total characters limit", () => {
      const trackerWithLowCharLimit = new ThinkOperationTracker({
        maxThinkOperations: 100,
        maxTotalThinkCharacters: 50,
      });

      trackerWithLowCharLimit.recordThinkOperation("A".repeat(30));
      trackerWithLowCharLimit.recordThinkOperation("B".repeat(30));

      const stats = trackerWithLowCharLimit.getStats();
      expect(stats.withinLimits).toBe(false);
      expect(stats.totalCharacters).toBe(60);
    });

    it("should reset counters correctly", () => {
      tracker.recordThinkOperation("First");
      tracker.recordThinkOperation("Second");
      tracker.reset();

      const stats = tracker.getStats();
      expect(stats.thinkCount).toBe(0);
      expect(stats.totalCharacters).toBe(0);
      expect(stats.withinLimits).toBe(true);
    });
  });

  describe("getStats", () => {
    it("should return correct max values from config", () => {
      const customTracker = new ThinkOperationTracker({
        maxThinkOperations: 42,
        maxTotalThinkCharacters: 99999,
      });

      const stats = customTracker.getStats();
      expect(stats.maxThinkCount).toBe(42);
      expect(stats.maxTotalCharacters).toBe(99999);
    });

    it("should estimate tokens correctly", () => {
      tracker.recordThinkOperation("ABCD");

      const stats = tracker.getStats();
      expect(stats.estimatedTokens).toBe(1);
    });
  });
});
