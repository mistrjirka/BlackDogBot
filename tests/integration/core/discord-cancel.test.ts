import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommandType } from "discord.js";
import path from "node:path";
import os from "node:os";

import { DiscordHandler } from "../../../src/platforms/discord/handler.js";
import type { IDiscordConfig } from "../../../src/shared/types/discord.types.js";
import { MainAgent } from "../../../src/agent/main-agent.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { MessagingService } from "../../../src/services/messaging.service.js";
import type { IPlatformDeps } from "../../../src/platforms/types.js";
import * as toolRegistry from "../../../src/helpers/tool-registry.js";
import { resetSingletons } from "../../utils/test-helpers.js";

function createMockDiscordConfig(): IDiscordConfig {
  return {
    botToken: "fake-token",
    channels: [
      {
        channelId: "channel-1",
        guildId: "guild-1",
        permission: "full",
        receiveNotifications: true,
      },
    ],
  };
}

function createMockDeps(): IPlatformDeps {
  return {
    mainAgent: MainAgent.getInstance(),
    messagingService: MessagingService.getInstance(),
    channelRegistry: ChannelRegistryService.getInstance(),
    toolRegistry,
    logger: LoggerService.getInstance(),
  };
}

function createMockClient() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

  return {
    handlers,
    on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
      const existing = handlers.get(event) ?? [];
      existing.push(callback);
      handlers.set(event, existing);
    }),
    emit(event: string, ...args: unknown[]): void {
      const existing = handlers.get(event) ?? [];
      for (const callback of existing) {
        void callback(...args);
      }
    },
  };
}

describe("Discord /cancel", () => {
  beforeEach(async () => {
    (DiscordHandler as unknown as { _instance: DiscordHandler | null })._instance = null;
    resetSingletons();
    const logger = LoggerService.getInstance();
    await logger.initializeAsync("info", path.join(os.tmpdir(), "test-logs"));
    const channelRegistry = ChannelRegistryService.getInstance();
    await channelRegistry.initializeAsync();
  });

  it("should stop chat and delete in-flight prompt on literal /cancel", async () => {
    const handler = DiscordHandler.getInstance();
    const client = createMockClient();
    const config = createMockDiscordConfig();

    await handler.initializeAsync(client as unknown as any, config, createMockDeps());

    const mainAgent = MainAgent.getInstance();
    vi.spyOn(mainAgent, "initializeForChatAsync").mockResolvedValue(undefined);

    let resolveProcess: () => void;
    const processBlocked: Promise<void> = new Promise<void>((resolve) => {
      resolveProcess = resolve;
    });

    vi.spyOn(mainAgent, "processMessageForChatAsync").mockImplementation(async () => {
      await processBlocked;
      return { text: "Operation was stopped.", stepsCount: 0 };
    });

    const stopSpy = vi.spyOn(mainAgent, "stopChat").mockReturnValue(true);

    const inFlightDeleteSpy = vi.fn().mockResolvedValue(undefined);
    const inFlightFetchSpy = vi.fn().mockResolvedValue({ delete: inFlightDeleteSpy });
    const textChannel = {
      isTextBased: (): boolean => true,
      sendTyping: vi.fn().mockResolvedValue(undefined),
      messages: {
        fetch: inFlightFetchSpy,
      },
    };

    const busyMessage = {
      author: { bot: false, username: "user" },
      content: "run something",
      channelId: "channel-1",
      guildId: "guild-1",
      id: "msg-100",
      createdTimestamp: Date.now(),
      channel: textChannel,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const handlePromise = (handler as unknown as { _handleMessageAsync: (msg: unknown) => Promise<void> })
      ._handleMessageAsync(busyMessage);

    await vi.waitUntil(() => {
      const processingSet = (handler as unknown as { _processing: Set<string> })._processing;
      return processingSet.has("channel-1");
    }, { timeout: 5000 });

    const cancelMessage = {
      author: { bot: false, username: "user" },
      content: "/cancel",
      channelId: "channel-1",
      guildId: "guild-1",
      id: "msg-101",
      createdTimestamp: Date.now(),
      channel: textChannel,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await (handler as unknown as { _handleMessageAsync: (msg: unknown) => Promise<void> })._handleMessageAsync(cancelMessage);

    expect(stopSpy).toHaveBeenCalledWith("channel-1");
    expect(inFlightFetchSpy).toHaveBeenCalledWith("msg-100");
    expect(cancelMessage.reply).toHaveBeenCalledWith(expect.stringContaining("Cancelled"));

    resolveProcess!();
    await handlePromise;
  });

  it("should reply ephemerally for slash /cancel", async () => {
    const handler = DiscordHandler.getInstance();
    const client = createMockClient();
    const config = createMockDiscordConfig();

    await handler.initializeAsync(client as unknown as any, config, createMockDeps());

    const mainAgent = MainAgent.getInstance();
    const stopSpy = vi.spyOn(mainAgent, "stopChat").mockReturnValue(true);

    const interaction = {
      isChatInputCommand: (): boolean => true,
      commandType: ApplicationCommandType.ChatInput,
      commandName: "cancel",
      channelId: "channel-1",
      channel: {
        isTextBased: (): boolean => true,
      },
      isRepliable: (): boolean => true,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await ChannelRegistryService.getInstance().registerChannelAsync("discord", "channel-1", {
      permission: "full",
      receiveNotifications: true,
      guildId: "guild-1",
    });

    await (handler as unknown as {
      _handleCancelSlashCommandAsync: (interaction: unknown) => Promise<void>;
    })._handleCancelSlashCommandAsync(interaction);

    expect(stopSpy).toHaveBeenCalledWith("channel-1");
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
  });
});
