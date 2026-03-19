import { describe, it, expect, vi } from "vitest";
import type { IRegisteredChannel } from "../../src/shared/types/channel.types.js";
import { ChatNotFoundError } from "../../src/utils/error.js";
import {
  notifySchedulerChannelsWithDedupAsync,
  type ISchedulerNotificationDeps,
  type ISchedulerNotificationLogger,
  type ISchedulerNotificationOptions,
} from "../../src/utils/scheduler-notifications.js";

function createChannel(platform: "telegram" | "discord", channelId: string): IRegisteredChannel {
  const now: string = new Date().toISOString();

  return {
    platform,
    channelId,
    permission: platform === "telegram" ? "full" : "read_only",
    receiveNotifications: true,
    createdAt: now,
    updatedAt: now,
  };
}

function createLogger(): ISchedulerNotificationLogger {
  return {
    info: vi.fn((_message: string, _meta?: Record<string, unknown>): void => {}),
    warn: vi.fn((_message: string, _meta?: Record<string, unknown>): void => {}),
    error: vi.fn((_message: string, _meta?: Record<string, unknown>): void => {}),
  };
}

describe("notifySchedulerChannelsWithDedupAsync", () => {
  it("should deduplicate by chat ID when invalid telegram channel falls back to a known chat", async () => {
    const channels: IRegisteredChannel[] = [
      createChannel("telegram", "chat-1"),
      createChannel("telegram", "5704031939"),
    ];

    const sendCalls: Array<{ platform: string; channelId: string; message: string }> = [];
    const logger: ISchedulerNotificationLogger = createLogger();

    const deps: ISchedulerNotificationDeps = {
      hasAdapter: (_platform): boolean => true,
      sendToChannelAsync: async (platform, channelId, message): Promise<void> => {
        sendCalls.push({ platform, channelId, message });

        if (platform === "telegram" && channelId === "chat-1") {
          throw new ChatNotFoundError(channelId);
        }
      },
      getKnownTelegramChatIds: (): string[] => ["5704031939"],
      logger,
    };

    const options: ISchedulerNotificationOptions = {
      errorPrefix: "Failed to send",
      logInvalidChannelWarning: true,
    };

    await notifySchedulerChannelsWithDedupAsync(channels, "hello", options, deps);

    const sentToPrimaryChat: number = sendCalls.filter(
      (call) => call.platform === "telegram" && call.channelId === "5704031939",
    ).length;

    expect(sentToPrimaryChat).toBe(1);
  });

  it("should deduplicate repeated direct channels for the same platform+chatId", async () => {
    const channels: IRegisteredChannel[] = [
      createChannel("telegram", "5704031939"),
      createChannel("telegram", "5704031939"),
      createChannel("discord", "channel-2"),
      createChannel("discord", "channel-2"),
    ];

    const sendCalls: Array<{ platform: string; channelId: string }> = [];

    const deps: ISchedulerNotificationDeps = {
      hasAdapter: (_platform): boolean => true,
      sendToChannelAsync: async (platform, channelId): Promise<void> => {
        sendCalls.push({ platform, channelId });
      },
      getKnownTelegramChatIds: (): string[] => [],
      logger: createLogger(),
    };

    await notifySchedulerChannelsWithDedupAsync(
      channels,
      "hello",
      { errorPrefix: "Failed to send" },
      deps,
    );

    const telegramCalls: number = sendCalls.filter(
      (call) => call.platform === "telegram" && call.channelId === "5704031939",
    ).length;
    const discordCalls: number = sendCalls.filter(
      (call) => call.platform === "discord" && call.channelId === "channel-2",
    ).length;

    expect(telegramCalls).toBe(1);
    expect(discordCalls).toBe(1);
  });
});
