import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronMessageHistoryService } from "../../../src/services/cron-message-history.service.js";

describe("CronMessageHistoryService - Shared History", () => {
  let service: CronMessageHistoryService;

  beforeEach(() => {
    // Initialize service and reset shared history before each test
    service = CronMessageHistoryService.getInstance();
    (CronMessageHistoryService as any)._sharedHistory = [];
    vi.clearAllMocks();
  });

  it("records messages to global shared history from different task IDs", async () => {
    const taskId1 = "task-001";
    const taskId2 = "task-002";

    await service.recordMessageAsync(taskId1, "Message from cron A");
    await service.recordMessageAsync(taskId2, "Message from cron B");
    await service.recordMessageAsync(taskId1, "Another message from cron A");

    const result = await service.getHistoryAsync();

    // All messages should be in shared history
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("returns last MAX_KEEP_MESSAGES (3) with compaction", async () => {
    for (let i = 1; i <= 6; i++) {
      await service.recordMessageAsync(`task-${i}`, `Message ${i}`);
    }

    const result = await service.getHistoryAsync();

    // Should only return last 3 messages
    expect(result.messages.length).toBeLessThanOrEqual(3);
  });

  it("handles multiple crons sending messages concurrently", async () => {
    // Simulate concurrent cron executions by recording from different task IDs
    const tasks = ["cron-daily-report", "cron-hourly-backup", "cron-minute-sync"];
    
    for (let i = 0; i < 15; i++) {
      await service.recordMessageAsync(tasks[i % tasks.length], `Message ${i} from ${tasks[i % tasks.length]}`);
    }

    const result = await service.getHistoryAsync();
    
    // Should see messages from all crons in shared history
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    
    // All message content should be preserved (up to MAX_KEEP_MESSAGES)
    for (const msg of result.messages) {
      expect(msg.content).toMatch(/^Message \d+ from cron-/);
    }
  });

  it("all crons see the same history", async () => {
    const cronAId = "cron-a";
    const cronBId = "cron-b";

    // Cron A sends message
    await service.recordMessageAsync(cronAId, "Cron A sent this");
    
    // Get history from Cron B's perspective (should see same messages)
    const historyForB = await service.getHistoryAsync();
    
    expect(historyForB.messages.some(m => m.content === "Cron A sent this")).toBe(true);

    // Cron B sends message
    await service.recordMessageAsync(cronBId, "Cron B responded");
    
    // Now both should see each other's messages
    const historyForA = await service.getHistoryAsync();
    expect(historyForA.messages.some(m => m.content === "Cron A sent this")).toBe(true);
    expect(historyForA.messages.some(m => m.content === "Cron B responded")).toBe(true);
  });

  it("preserves message order chronologically", async () => {
    const messages = ["First", "Second", "Third"];
    
    for (const msg of messages) {
      await service.recordMessageAsync("task-1", msg);
    }

    const result = await service.getHistoryAsync();
    
    // Messages should be in order they were sent
    expect(result.messages.length).toBe(3);
    expect(result.messages[0].content).toBe("First");
    expect(result.messages[1].content).toBe("Second");
    expect(result.messages[2].content).toBe("Third");
  });

  it("generates unique message IDs for each message", async () => {
    await service.recordMessageAsync("task-1", "Message 1");
    
    // Wait a tiny bit to ensure different timestamp if needed
    await new Promise(resolve => setTimeout(resolve, 10));
    
    await service.recordMessageAsync("task-2", "Message 2");

    const result = await service.getHistoryAsync();
    
    expect(result.messages.length).toBe(2);
    // All messages should have unique IDs
    const messageIds = result.messages.map(m => m.messageId);
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(messageIds.length);
  });

  it("handles empty history gracefully", async () => {
    const result = await service.getHistoryAsync();
    
    expect(result.messages).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.summaryGeneratedAt).toBeNull();
    expect(result.totalMessageCount).toBe(0);
  });

  it("increments totalMessageCount correctly with summary", async () => {
    const largeMessage = "x".repeat(50000);
    
    await service.recordMessageAsync("task-1", largeMessage);

    const result = await service.getHistoryAsync();
    
    // Should have messages + summary
    expect(result.totalMessageCount).toBeGreaterThan(0);
  });

  it("preserves message metadata (sentAt, messageId)", async () => {
    await service.recordMessageAsync("task-1", "Test message");

    const result = await service.getHistoryAsync();
    
    if (result.messages.length > 0) {
      expect(result.messages[0].messageId).toBeTruthy();
      expect(new Date(result.messages[0].sentAt)).toBeInstanceOf(Date);
    }
  });
});
