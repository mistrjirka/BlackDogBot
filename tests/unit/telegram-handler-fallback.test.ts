import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { TelegramHandler } from "../../src/platforms/telegram/handler.js";
import { MessagingService } from "../../src/services/messaging.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { resetSingletons } from "../utils/test-helpers.js";

describe("TelegramHandler fallback delivery", () => {
  beforeEach((): void => {
    resetSingletons();
    (TelegramHandler as unknown as { _instance: TelegramHandler | null })._instance = null;
  });

  afterEach((): void => {
    (TelegramHandler as unknown as { _instance: TelegramHandler | null })._instance = null;
    resetSingletons();
    vi.restoreAllMocks();
  });

  it("should not log queued retry when fallback send succeeds immediately", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const messagingService: MessagingService = MessagingService.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    const sendMessageSpy = vi
      .spyOn(messagingService, "sendMessageAsync")
      .mockResolvedValue("123456");
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(undefined);

    await (handler as unknown as {
      _queueTelegramMessageFallbackAsync: (chatId: string, message: string, source: string) => Promise<void>;
    })._queueTelegramMessageFallbackAsync("chat-1", "hello", "test-source");

    expect(sendMessageSpy).toHaveBeenCalledWith({
      text: "hello",
      platform: "telegram",
      userId: "chat-1",
      replyToMessageId: null,
    });
    expect(
      warnSpy.mock.calls.some((call: unknown[]): boolean => call[0] === "Direct Telegram reply failed; queued for retry"),
    ).toBe(false);
    expect(
      infoSpy.mock.calls.some((call: unknown[]): boolean => call[0] === "Direct Telegram reply failed; fallback sent immediately"),
    ).toBe(true);
  });

  it("should log queued retry when fallback send is enqueued", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const messagingService: MessagingService = MessagingService.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    vi.spyOn(messagingService, "sendMessageAsync").mockResolvedValue("tgout-chat-1-queued");
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(undefined);

    await (handler as unknown as {
      _queueTelegramMessageFallbackAsync: (chatId: string, message: string, source: string) => Promise<void>;
    })._queueTelegramMessageFallbackAsync("chat-1", "hello", "test-source");

    expect(
      warnSpy.mock.calls.some((call: unknown[]): boolean => call[0] === "Direct Telegram reply failed; queued for retry"),
    ).toBe(true);
  });

  it("should use fallback when cancel response reply fails", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    const messagingService: MessagingService = MessagingService.getInstance();

    const sendMessageSpy = vi
      .spyOn(messagingService, "sendMessageAsync")
      .mockResolvedValue("msg-via-fallback");

    const result = await (handler as unknown as {
      _safeReplyOrQueueAsync: (
        ctx: { reply: (msg: string) => Promise<unknown> },
        chatId: string,
        message: string,
      ) => Promise<void>;
    })._safeReplyOrQueueAsync(
      { reply: vi.fn().mockRejectedValue(new Error("network error")) } as unknown as { reply: (msg: string) => Promise<unknown> },
      "chat-cancel",
      "Cancelled: stopped current generation.",
    );

    expect(sendMessageSpy).toHaveBeenCalledWith({
      text: "Cancelled: stopped current generation.",
      platform: "telegram",
      userId: "chat-cancel",
      replyToMessageId: null,
    });
  });
});
