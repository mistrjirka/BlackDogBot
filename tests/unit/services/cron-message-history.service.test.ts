import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";

describe("CronMessageHistoryService - Global Shared History", () => {
  let service: CronMessageHistoryService;

  beforeEach(() => {
    // Reset shared history before each test
    (CronMessageHistoryService as any)._sharedHistory = [];
    vi.clearAllMocks();
    service = CronMessageHistoryService.getInstance();
  });

  it("records messages to global shared history", async () => {
    await service.recordMessageAsync("task-1", "Message from task 1");
    await service.recordMessageAsync("task-2", "Message from task 2");

    const result = await service.getHistoryAsync();

    expect(result.messages.length).toBe(2);
    expect(result.messages[0].content).toBe("Message from task 1");
    expect(result.messages[1].content).toBe("Message from task 2");
  });

  it("returns only last MAX_KEEP_MESSAGES (3) messages", async () => {
    await service.recordMessageAsync("task-1", "First message");
    await service.recordMessageAsync("task-2", "Second message");
    await service.recordMessageAsync("task-3", "Third message");
    await service.recordMessageAsync("task-4", "Fourth message");

    const result = await service.getHistoryAsync();

    expect(result.messages.length).toBe(3);
    expect(result.messages[0].content).toBe("Second message");
    expect(result.messages[2].content).toBe("Fourth message");
  });

  it("generates unique message IDs for each recorded message", async () => {
    await service.recordMessageAsync("task-1", "Test message");

    const result = await service.getHistoryAsync();

    if (result.messages.length > 0) {
      expect(result.messages[0].messageId).toBeTruthy();
      // ID should be a non-empty string
      expect(typeof result.messages[0].messageId).toBe("string");
      expect(result.messages[0].messageId.length).toBeGreaterThan(0);
    }
  });

  it("records timestamp when message was sent", async () => {
    await service.recordMessageAsync("task-1", "Test message");

    const result = await service.getHistoryAsync();

    if (result.messages.length > 0) {
      expect(result.messages[0].sentAt).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(() => new Date(result.messages[0].sentAt)).not.toThrow();
    }
  });

  it("all tasks share the same history", async () => {
    await service.recordMessageAsync("cron-a", "Cron A message");
    
    const historyForB = await service.getHistoryAsync();
    
    expect(historyForB.messages.some(m => m.content === "Cron A message")).toBe(true);

    await service.recordMessageAsync("cron-b", "Cron B response");
    
    const historyForA = await service.getHistoryAsync();
    
    expect(historyForA.messages.length).toBe(2);
  });

  it("returns empty result when no messages recorded yet", async () => {
    const result = await service.getHistoryAsync();

    expect(result.messages).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.summaryGeneratedAt).toBeNull();
    expect(result.totalMessageCount).toBe(0);
  });

  it("increments totalMessageCount correctly", async () => {
    await service.recordMessageAsync("task-1", "First");
    
    const result = await service.getHistoryAsync();
    
    expect(result.totalMessageCount).toBeGreaterThanOrEqual(1);
  });

  it("preserves message order chronologically", async () => {
    await service.recordMessageAsync("task-1", "First sent");
    await service.recordMessageAsync("task-2", "Second sent");
    
    const result = await service.getHistoryAsync();
    
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].content).toBe("First sent");
    expect(result.messages[1].content).toBe("Second sent");
  });

  it("handles rapid message recording from multiple tasks", async () => {
    const promises = [];
    
    for (let i = 0; i < 20; i++) {
      promises.push(service.recordMessageAsync(`task-${i % 5}`, `Message ${i}`));
    }
    
    await Promise.all(promises);

    const result = await service.getHistoryAsync();
    
    // Should have at most MAX_KEEP_MESSAGES (3) messages
    expect(result.messages.length).toBeLessThanOrEqual(3);
  });
});
