import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { MessagingService } from "../../../src/services/messaging.service.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { TelegramHandler } from "../../../src/platforms/telegram/handler.js";
import { MainAgent } from "../../../src/agent/main-agent.js";
import type { ITelegramConfig } from "../../../src/platforms/telegram/types.js";
import type { IPlatformDeps } from "../../../src/platforms/types.js";

let tempDir: string;
let originalHome: string;


function createMockDeps(): IPlatformDeps {
  return {
    mainAgent: MainAgent.getInstance(),
    messagingService: MessagingService.getInstance(),
    channelRegistry: ChannelRegistryService.getInstance(),
    toolRegistry: {
      isToolAllowed: () => true,
      getAllowedToolNames: () => [],
    } as any,
    logger: LoggerService.getInstance(),
  };
}

function createMockTelegramConfig(allowedUsers?: string[]): ITelegramConfig {
  return {
    botToken: "test-token",
    allowedUsers,
  };
}

function createMockCtx(chatId: string): any {
  const replyFn = vi.fn().mockResolvedValue({ message_id: 123 });
  const apiObj = {
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };

  return {
    message: {
      text: "hello",
      chat: { id: chatId },
      from: { username: "testuser", first_name: "Test" },
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
    },
    reply: replyFn,
    api: apiObj,
  };
}

async function modifyYamlConfig(configPath: string, modifier: (config: any) => void): Promise<void> {
  const content: string = await fs.readFile(configPath, "utf-8");
  const config = parseYaml(content);
  modifier(config);
  await fs.writeFile(configPath, stringifyYaml(config), "utf-8");
}

describe("TelegramHandler authorization", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-telegram-auth-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();
    (TelegramHandler as unknown as { _instance: TelegramHandler | null })._instance = null;

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const betterclawDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(betterclawDir, "config.yaml");

    await fs.mkdir(betterclawDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);
  });

  afterEach(async () => {
    resetSingletons();
    (TelegramHandler as unknown as { _instance: TelegramHandler | null })._instance = null;
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should allow the first user when knownChatIds is empty and no allowedUsers in config", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(), createMockDeps());

    (handler as any)._knownChatIds = new Set<string>();

    const ctx = createMockCtx("111");

    vi.spyOn(MainAgent.getInstance() as any, "processMessageForChatAsync").mockResolvedValue({
      text: "Hello!",
      stepsCount: 1,
    });

    await handler.handleMessageAsync(ctx);

    expect(ctx.reply).toHaveBeenCalled();

    const knownChatIds = (handler as any)._knownChatIds as Set<string>;
    expect(knownChatIds.has("111")).toBe(true);

    const chatsFile: string = path.join(tempDir, ".betterclaw", "known-telegram-chats.json");
    const content: string = await fs.readFile(chatsFile, "utf-8");
    expect(JSON.parse(content)).toContain("111");
  });

  it("should reject a second user after the first was registered", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(), createMockDeps());

    (handler as any)._knownChatIds = new Set<string>(["111"]);

    const ctx = createMockCtx("222");

    await handler.handleMessageAsync(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();

    const knownChatIds = (handler as any)._knownChatIds as Set<string>;
    expect(knownChatIds.has("222")).toBe(false);
  });

  it("should allow users listed in config.telegram.allowedUsers", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(["333"]), createMockDeps());

    const ctx = createMockCtx("333");

    vi.spyOn(MainAgent.getInstance() as any, "processMessageForChatAsync").mockResolvedValue({
      text: "Hello!",
      stepsCount: 1,
    });

    await handler.handleMessageAsync(ctx);

    expect(ctx.reply).toHaveBeenCalled();
  });

  it("should reject users NOT in config.telegram.allowedUsers", async () => {
    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(["333"]), createMockDeps());

    const ctx = createMockCtx("444");

    await handler.handleMessageAsync(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("should override saved file when allowedUsers is set in config", async () => {
    const knownChatsFile: string = path.join(tempDir, ".betterclaw", "known-telegram-chats.json");
    await fs.writeFile(knownChatsFile, '["555"]');

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(["666"]), createMockDeps());

    const chatIds: string[] = handler.getKnownChatIds();
    expect(chatIds).toEqual(["666"]);
  });

  it("should load saved chat IDs from file when no allowedUsers in config", async () => {
    const knownChatsFile: string = path.join(tempDir, ".betterclaw", "known-telegram-chats.json");
    await fs.writeFile(knownChatsFile, '["777"]');

    (ConfigService as any)._instance = null;
    const configService: ConfigService = ConfigService.getInstance();
    const configPath: string = path.join(tempDir, ".betterclaw", "config.yaml");
    await configService.initializeAsync(configPath);

    const handler: TelegramHandler = TelegramHandler.getInstance();
    await handler.initializeAsync(createMockTelegramConfig(), createMockDeps());

    const chatIds: string[] = handler.getKnownChatIds();
    expect(chatIds).toContain("777");
  });
});
