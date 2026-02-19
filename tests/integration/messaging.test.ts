import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  MessagingService,
  TelegramAdapter,
  type IPlatformAdapter,
} from "../../src/services/messaging.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { IOutgoingMessage } from "../../src/shared/types/messaging.types.js";

//#region Helpers

function resetSingletons(): void {
  (MessagingService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

function createFakeAdapter(platform: "telegram" | "console" | "api"): IPlatformAdapter {
  return {
    platform,
    sendMessageAsync: vi.fn().mockResolvedValue("msg-123"),
  };
}

//#endregion Helpers

//#region Tests

describe("MessagingService", () => {
  beforeEach(() => {
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(() => {
    resetSingletons();
    vi.restoreAllMocks();
  });

  it("should register an adapter and use it to send a message", async () => {
    const service: MessagingService = MessagingService.getInstance();
    const adapter: IPlatformAdapter = createFakeAdapter("telegram");

    service.registerAdapter(adapter);

    const message: IOutgoingMessage = {
      text: "Hello!",
      platform: "telegram",
      userId: "user-1",
      replyToMessageId: null,
    };

    const messageId: string | null = await service.sendMessageAsync(message);

    expect(messageId).toBe("msg-123");
    expect(adapter.sendMessageAsync).toHaveBeenCalledWith(message);
  });

  it("should throw when no adapter is registered for the platform", async () => {
    const service: MessagingService = MessagingService.getInstance();

    const message: IOutgoingMessage = {
      text: "Hello!",
      platform: "console",
      userId: "user-1",
      replyToMessageId: null,
    };

    await expect(service.sendMessageAsync(message)).rejects.toThrow(
      "No messaging adapter registered for platform: console",
    );
  });

  it("should support multiple adapters for different platforms", async () => {
    const service: MessagingService = MessagingService.getInstance();
    const telegramAdapter: IPlatformAdapter = createFakeAdapter("telegram");
    const consoleAdapter: IPlatformAdapter = createFakeAdapter("console");

    service.registerAdapter(telegramAdapter);
    service.registerAdapter(consoleAdapter);

    const telegramMsg: IOutgoingMessage = {
      text: "Telegram message",
      platform: "telegram",
      userId: "user-1",
      replyToMessageId: null,
    };

    const consoleMsg: IOutgoingMessage = {
      text: "Console message",
      platform: "console",
      userId: "user-2",
      replyToMessageId: null,
    };

    await service.sendMessageAsync(telegramMsg);
    await service.sendMessageAsync(consoleMsg);

    expect(telegramAdapter.sendMessageAsync).toHaveBeenCalledWith(telegramMsg);
    expect(consoleAdapter.sendMessageAsync).toHaveBeenCalledWith(consoleMsg);
  });

  it("should create a sender function bound to a specific chat", async () => {
    const service: MessagingService = MessagingService.getInstance();
    const adapter: IPlatformAdapter = createFakeAdapter("telegram");

    service.registerAdapter(adapter);

    const sender = service.createSenderForChat("telegram", "chat-42");

    const result: string | null = await sender("Hi from sender");

    expect(result).toBe("msg-123");
    expect(adapter.sendMessageAsync).toHaveBeenCalledWith({
      text: "Hi from sender",
      platform: "telegram",
      userId: "chat-42",
      replyToMessageId: null,
    });
  });
});

describe("TelegramAdapter", () => {
  beforeEach(() => {
    resetSingletons();
  });

  afterEach(() => {
    resetSingletons();
    vi.restoreAllMocks();
  });

  it("should set platform to telegram", () => {
    const fakeBot = { api: { sendMessage: vi.fn() } } as unknown as import("grammy").Bot;
    const adapter: TelegramAdapter = new TelegramAdapter(fakeBot);

    expect(adapter.platform).toBe("telegram");
  });

  it("should call bot.api.sendMessage and return the message ID as string", async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 999 });
    const fakeBot = { api: { sendMessage: sendMessageMock } } as unknown as import("grammy").Bot;
    const adapter: TelegramAdapter = new TelegramAdapter(fakeBot);

    const message: IOutgoingMessage = {
      text: "Test message",
      platform: "telegram",
      userId: "12345",
      replyToMessageId: null,
    };

    const result: string | null = await adapter.sendMessageAsync(message);

    expect(result).toBe("999");
    expect(sendMessageMock).toHaveBeenCalledWith("12345", "Test message", {
      parse_mode: "Markdown",
    });
  });
});

//#endregion Tests
