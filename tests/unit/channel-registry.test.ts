import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ChannelRegistryService } from "../../src/services/channel-registry.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import type { IRegisteredChannel } from "../../src/shared/types/channel.types.js";

function resetSingletons(): void {
  (ChannelRegistryService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

async function createTempChannelsFile(
  content: Record<string, unknown>
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tempDir = path.join(process.cwd(), "tests", "temp");
  await fs.mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `channels-${Date.now()}.yaml`);

  const yaml = require("js-yaml");
  await fs.writeFile(filePath, yaml.dump(content));

  return {
    filePath,
    cleanup: async () => {
      try {
        await fs.unlink(filePath);
      } catch {}
    },
  };
}

describe("ChannelRegistryService", () => {
  let registry: ChannelRegistryService;

  beforeEach(() => {
    resetSingletons();

    const logger = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();

    // Clean up temp directory
    try {
      const tempDir = path.join(process.cwd(), "tests", "temp");
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("getPermission", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should return 'ignore' for unknown channels", () => {
      expect(registry.getPermission("discord", "12345")).toBe("ignore");
      expect(registry.getPermission("telegram", "unknown-chat")).toBe("ignore");
    });
  });

  describe("registerChannelAsync", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should register a new channel with default values", async () => {
      const channel = await registry.registerChannelAsync("discord", "channel-1");

      expect(channel.platform).toBe("discord");
      expect(channel.channelId).toBe("channel-1");
      expect(channel.permission).toBe("read_only");
      expect(channel.receiveNotifications).toBe(true);
    });

    it("should register a telegram channel with 'full' permission by default", async () => {
      const channel = await registry.registerChannelAsync("telegram", "chat-1");

      expect(channel.permission).toBe("full");
      expect(channel.receiveNotifications).toBe(true);
    });

    it("should register a channel with custom values", async () => {
      const channel = await registry.registerChannelAsync("telegram", "chat-42", {
        permission: "full",
        receiveNotifications: true,
        guildId: "guild-1",
      });

      expect(channel.permission).toBe("full");
      expect(channel.receiveNotifications).toBe(true);
      expect(channel.guildId).toBe("guild-1");
    });

    it("should update an existing channel", async () => {
      await registry.registerChannelAsync("discord", "channel-1", {
        permission: "read_only",
      });

      const updated = await registry.registerChannelAsync("discord", "channel-1", {
        permission: "full",
        receiveNotifications: true,
      });

      expect(updated.permission).toBe("full");
      expect(updated.receiveNotifications).toBe(true);
    });
  });

  describe("getNotificationChannels", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should return empty array when no channels have notifications enabled", () => {
      expect(registry.getNotificationChannels()).toEqual([]);
    });

    it("should return channels with receiveNotifications=true", async () => {
      await registry.registerChannelAsync("telegram", "chat-1", {
        permission: "full",
        receiveNotifications: true,
      });
      await registry.registerChannelAsync("discord", "channel-2", {
        permission: "read_only",
        receiveNotifications: true,
      });
      await registry.registerChannelAsync("telegram", "chat-3", {
        permission: "full",
        receiveNotifications: false,
      });

      const channels = registry.getNotificationChannels();

      expect(channels.length).toBe(2);
      expect(channels.map((c) => c.channelId)).toContain("chat-1");
      expect(channels.map((c) => c.channelId)).toContain("channel-2");
      expect(channels.map((c) => c.channelId)).not.toContain("chat-3");
    });
  });

  describe("setNotificationsEnabledAsync", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should enable notifications for an existing channel", async () => {
      await registry.registerChannelAsync("telegram", "chat-1");
      const result = await registry.setNotificationsEnabledAsync("telegram", "chat-1", true);

      expect(result).toBe(true);
      expect(registry.getNotificationChannels().map((c) => c.channelId)).toContain("chat-1");
    });

    it("should disable notifications for an existing channel", async () => {
      await registry.registerChannelAsync("telegram", "chat-1", { receiveNotifications: true });
      const result = await registry.setNotificationsEnabledAsync("telegram", "chat-1", false);

      expect(result).toBe(true);
      expect(registry.getNotificationChannels().map((c) => c.channelId)).not.toContain("chat-1");
    });

    it("should return false for unknown channel", async () => {
      const result = await registry.setNotificationsEnabledAsync("telegram", "unknown", true);
      expect(result).toBe(false);
    });
  });

  describe("hasChannel", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should return false for unknown channel", () => {
      expect(registry.hasChannel("telegram", "unknown")).toBe(false);
    });

    it("should return true for registered channel", async () => {
      await registry.registerChannelAsync("discord", "channel-1");
      expect(registry.hasChannel("discord", "channel-1")).toBe(true);
    });
  });

  describe("getChannel", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should return undefined for unknown channel", () => {
      expect(registry.getChannel("telegram", "unknown")).toBeUndefined();
    });

    it("should return channel for registered channel", async () => {
      await registry.registerChannelAsync("telegram", "chat-1", { permission: "full" });
      const channel = registry.getChannel("telegram", "chat-1");

      expect(channel).toBeDefined();
      expect(channel?.permission).toBe("full");
    });
  });

  describe("getAllChannels", () => {
    beforeEach(() => {
      registry = ChannelRegistryService.getInstance();
    });

    it("should return all registered channels", async () => {
      await registry.registerChannelAsync("telegram", "chat-1");
      await registry.registerChannelAsync("discord", "channel-2");

      const all = registry.getAllChannels();

      expect(all.length).toBe(2);
      expect(all.map((c) => c.channelId)).toContain("chat-1");
      expect(all.map((c) => c.channelId)).toContain("channel-2");
    });
  });
});
