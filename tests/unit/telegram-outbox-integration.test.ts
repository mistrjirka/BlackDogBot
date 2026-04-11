import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessagingService, type IPlatformAdapter } from "../../src/services/messaging.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { IOutgoingMessage, IOutgoingPhoto } from "../../src/shared/types/messaging.types.js";
import { getBaseDir } from "../../src/utils/paths.js";
import { createTestEnvironment, resetSingletons, silenceLogger } from "../utils/test-helpers.js";

function createTelegramAdapter(sendImpl: (message: IOutgoingMessage) => Promise<string | null>): IPlatformAdapter {
  return {
    platform: "telegram",
    sendMessageAsync: vi.fn(sendImpl),
    sendPhotoAsync: vi.fn(async (_photo: IOutgoingPhoto): Promise<string | null> => "photo-1"),
    sendChatActionAsync: vi.fn(async (): Promise<void> => {}),
  };
}

describe("Telegram outbox integration", () => {
  const env = createTestEnvironment("telegram-outbox");

  beforeEach(async () => {
    await env.setupAsync({ logLevel: "debug" });
    const loggerService: LoggerService = LoggerService.getInstance();
    silenceLogger(loggerService);
    vi.spyOn(loggerService as unknown as { _writeToFileAsync: (line: string) => Promise<void> }, "_writeToFileAsync")
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const loggerService = LoggerService.getInstance() as unknown as { _logFilePath: string | null };
    loggerService._logFilePath = null;
    await new Promise((resolve): NodeJS.Timeout => setTimeout(resolve, 50));
    vi.restoreAllMocks();
    try {
      MessagingService.getInstance().shutdownTelegramOutbox();
    } catch {
      // ignore
    }
    resetSingletons();
    await env.teardownAsync();
  });

  it("queues telegram message when network send fails", async () => {
    const service: MessagingService = MessagingService.getInstance();
    await service.initializeTelegramOutboxAsync(10);
    service.stopTelegramOutboxWorker();
    const adapter: IPlatformAdapter = createTelegramAdapter(async (): Promise<string | null> => {
      throw new Error("Network request for 'sendMessage' failed!");
    });

    service.registerAdapter(adapter);

    const queuedId: string | null = await service.sendMessageAsync({
      text: "hello queued world",
      platform: "telegram",
      userId: "5704031939",
      replyToMessageId: null,
    });

    expect(queuedId).toBeTypeOf("string");

    const outboxDbPath: string = path.join(getBaseDir(), "databases", "telegram-outbox.db");
    const db = new Database(outboxDbPath, { readonly: true });

    const row = db
      .prepare("SELECT chat_id, message, status FROM telegram_outbox WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1")
      .get("5704031939") as { chat_id: string; message: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.chat_id).toBe("5704031939");
    expect(row?.message).toContain("hello queued world");
    expect(row?.status).toBe("pending");

    db.close();
  });

  it("keeps only latest 10 pending messages per chat", async () => {
    const service: MessagingService = MessagingService.getInstance();
    await service.initializeTelegramOutboxAsync(10);
    service.stopTelegramOutboxWorker();
    const adapter: IPlatformAdapter = createTelegramAdapter(async (): Promise<string | null> => {
      throw new Error("Network request for 'sendMessage' failed!");
    });

    service.registerAdapter(adapter);

    for (let i = 0; i < 12; i += 1) {
      await service.sendMessageAsync({
        text: `queued-${i}`,
        platform: "telegram",
        userId: "5704031939",
        replyToMessageId: null,
      });
    }

    const outboxDbPath: string = path.join(getBaseDir(), "databases", "telegram-outbox.db");
    const db = new Database(outboxDbPath, { readonly: true });

    const pendingCount = db
      .prepare("SELECT COUNT(*) as count FROM telegram_outbox WHERE chat_id = ? AND status = 'pending'")
      .get("5704031939") as { count: number };

    const droppedCount = db
      .prepare("SELECT COUNT(*) as count FROM telegram_outbox WHERE chat_id = ? AND status = 'dropped_by_cap'")
      .get("5704031939") as { count: number };

    expect(pendingCount.count).toBe(10);
    expect(droppedCount.count).toBe(2);

    db.close();
  });

  it("retries queued telegram messages when adapter becomes available", async () => {
    const service: MessagingService = MessagingService.getInstance();
    await service.initializeTelegramOutboxAsync(10);
    service.stopTelegramOutboxWorker();

    let online = false;
    const sent: string[] = [];
    const adapter: IPlatformAdapter = createTelegramAdapter(async (message: IOutgoingMessage): Promise<string | null> => {
      if (!online) {
        throw new Error("Network request for 'sendMessage' failed!");
      }

      sent.push(message.text);
      return `sent-${sent.length}`;
    });

    service.registerAdapter(adapter);

    await service.sendMessageAsync({
      text: "replay-me",
      platform: "telegram",
      userId: "5704031939",
      replyToMessageId: null,
    });

    online = true;
    service.startTelegramOutboxWorker(20);

    await new Promise((resolve): NodeJS.Timeout => setTimeout(resolve, 80));
    service.stopTelegramOutboxWorker();

    const outboxDbPath: string = path.join(getBaseDir(), "databases", "telegram-outbox.db");
    const db = new Database(outboxDbPath, { readonly: true });

    const sentCount = db
      .prepare("SELECT COUNT(*) as count FROM telegram_outbox WHERE chat_id = ? AND status = 'sent'")
      .get("5704031939") as { count: number };

    expect(sent).toContain("replay-me");
    expect(sentCount.count).toBeGreaterThanOrEqual(1);

    db.close();
  });
});
