import { Context, Bot } from "grammy";

import { LoggerService } from "../../services/logger.service.js";
import { PromptService } from "../../services/prompt.service.js";
import { MainAgent } from "../../agent/main-agent.js";
import { ChannelRegistryService } from "../../services/channel-registry.service.js";
import { McpRegistryService } from "../../services/mcp-registry.service.js";
import { McpService } from "../../services/mcp.service.js";
import { TelegramHandler } from "./handler.js";
import { factoryResetAsync, type IFactoryResetResult } from "../../services/factory-reset.service.js";
import { extractErrorMessage } from "../../utils/error.js";
import type { IMcpServerConfig, IMcpServersFile } from "../../shared/types/mcp.types.js";
import { mcpServerConfigSchema } from "../../shared/schemas/mcp.schemas.js";

//#region Telegram Commands

/**
 * Set up Telegram bot commands.
 * Handles /start, /help, /clear, /reset, /factory_reset, /notifications_enable, /notifications_disable, /status
 */
export function setupTelegramCommands(bot: Bot): void {
  const logger = LoggerService.getInstance();
  const channelRegistry = ChannelRegistryService.getInstance();
  const promptService = PromptService.getInstance();
  const mainAgent = MainAgent.getInstance();
  const telegramHandler = TelegramHandler.getInstance();

  // /start command
  bot.command("start", async (ctx: Context): Promise<void> => {
    await ctx.reply("BetterClaw is ready. Send me a message to get started.");
  });

  // /help command
  bot.command("help", async (ctx: Context): Promise<void> => {
    const helpText: string = [
      "Available commands:",
      "/start — Initialize the bot",
      "/help — Show this help message",
      "/clear — Clear conversation history for this chat",
      "/reset [name|all] — Reset prompt(s) to factory defaults",
      "/factory_reset — Full nuclear reset: delete all jobs, knowledge, tasks, skills, prompts, workspace, logs, and chat history",
      "/update_prompts — Update all prompts from source defaults",
      "/cancel — Stop current generation and delete the active prompt",
      "/notifications_enable — Enable cron notifications for this chat",
      "/notifications_disable — Disable cron notifications for this chat",
      "/status — Show current chat status",
      "/add_mcp_server — Add an MCP server (paste JSON)",
      "/list_mcp_servers — List configured MCP servers",
      "/remove_mcp_server <id> — Remove an MCP server",
      "/mcp_status — Show MCP connection status",
    ].join("\n");

    await ctx.reply(helpText);
  });

  // /clear command
  bot.command("clear", async (ctx: Context): Promise<void> => {
    const chatId: string = String(ctx.chat?.id);

    mainAgent.clearChatHistory(chatId);
    await ctx.reply("Conversation history cleared.");
    logger.info("Chat history cleared via /clear command.", { chatId });
  });

  // /cancel command
  bot.command("cancel", async (ctx: Context): Promise<void> => {
    await telegramHandler.handleCancelCommandAsync(ctx);
  });

  // /reset command
  bot.command("reset", async (ctx: Context): Promise<void> => {
    const args: string = typeof ctx.match === "string" ? ctx.match : "";

    try {
      if (!args || args === "all") {
        await promptService.resetAllPromptsAsync();
        await ctx.reply("All prompts have been reset to factory defaults.");
        logger.info("All prompts reset via /reset command.");
      } else {
        const promptName: string = args.trim();
        await promptService.resetPromptAsync(promptName);
        await ctx.reply(`Prompt "${promptName}" has been reset to factory default.`);
        logger.info("Prompt reset via /reset command.", { promptName });
      }
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      await ctx.reply(`Failed to reset: ${errorMessage}`);
      logger.error("Failed to reset prompt via /reset command.", { error: errorMessage });
    }
  });

  // /factory_reset command
  bot.command("factory_reset", async (ctx: Context): Promise<void> => {
    await ctx.reply(
      "Starting factory reset — this will delete ALL data (jobs, knowledge, tasks, skills state, prompts, workspace, logs, chat history)..."
    );

    try {
      const result: IFactoryResetResult = await factoryResetAsync();

      if (result.success) {
        await ctx.reply("Factory reset complete. All data has been wiped and prompts restored to defaults.");
      } else {
        const errorSummary: string = result.errors.join("\n");
        await ctx.reply(`Factory reset completed with errors:\n${errorSummary}`);
      }
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      await ctx.reply(`Factory reset failed: ${errorMessage}`);
      logger.error("Factory reset failed.", { error: errorMessage });
    }
  });

  // /update_prompts command
  bot.command("update_prompts", async (ctx: Context): Promise<void> => {
    try {
      await promptService.resetAllPromptsAsync();

      await ctx.reply("All prompts have been updated from source defaults.");
      logger.info("Prompts updated from source defaults via /update_prompts command.");
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      await ctx.reply(`Failed to update prompts: ${errorMessage}`);
      logger.error("Failed to update prompts via /update_prompts command.", { error: errorMessage });
    }
  });

  // /notifications_enable command
  bot.command("notifications_enable", async (ctx: Context): Promise<void> => {
    const chatId = String(ctx.chat?.id);

    if (!chatId) {
      await ctx.reply("Error: Could not determine chat ID.");
      return;
    }

    // Register channel if not exists, or update existing
    await channelRegistry.registerChannelAsync("telegram", chatId, {
      permission: "full",
      receiveNotifications: true,
    });

    await ctx.reply("✅ Notifications *enabled* for this chat. You will receive cron task alerts here.", {
      parse_mode: "Markdown",
    });
    logger.info("Notifications enabled via command", { chatId });
  });

  // /notifications_disable command
  bot.command("notifications_disable", async (ctx: Context): Promise<void> => {
    const chatId = String(ctx.chat?.id);

    if (!chatId) {
      await ctx.reply("Error: Could not determine chat ID.");
      return;
    }

    const success = await channelRegistry.setNotificationsEnabledAsync("telegram", chatId, false);

    if (success) {
      await ctx.reply(
        "🔕 Notifications *disabled* for this chat. You will no longer receive cron task alerts here.",
        { parse_mode: "Markdown" }
      );
      logger.info("Notifications disabled via command", { chatId });
    } else {
      await ctx.reply("This chat is not registered. Notifications were never enabled.");
    }
  });

  // /status command
  bot.command("status", async (ctx: Context): Promise<void> => {
    const chatId = String(ctx.chat?.id);
    const channel = channelRegistry.getChannel("telegram", chatId);

    if (!channel) {
      await ctx.reply(
        "📊 Chat Status\n\n" +
          "This chat is not yet registered.\n" +
          "Send any message to register, or use /notifications_enable"
      );
      return;
    }

    const statusLines = [
      "📊 Chat Status",
      "",
      `Permission: ${channel.permission}`,
      `Notifications: ${channel.receiveNotifications ? "✅ Enabled" : "🔕 Disabled"}`,
      `Registered: ${new Date(channel.createdAt).toLocaleDateString()}`,
    ];

    await ctx.reply(statusLines.join("\n"));
  });

  // /add_mcp_server command
  bot.command("add_mcp_server", async (ctx: Context): Promise<void> => {
    const raw: string = (typeof ctx.match === "string" ? ctx.match : "").trim();

    if (!raw) {
      await ctx.reply(
        "Usage: /add_mcp_server <json>\n\n" +
        "Paste a VS Code MCP config. Two accepted shapes:\n\n" +
        '1) Full config (copy from VS Code/Claude Desktop):\n```json\n' +
        '{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}\n```\n\n' +
        '2) Single server entry (include "name" to set the server id):\n```json\n' +
        '{"name":"playwright","command":"npx","args":["@playwright/mcp@latest"]}\n```\n\n' +
        "Or for remote servers:\n```json\n" +
        '{"name":"github","url":"https://api.github.com/mcp","headers":{"Authorization":"Bearer YOUR_TOKEN"}}\n```',
        { parse_mode: "Markdown" },
      );
      return;
    }

    const mcpRegistry = McpRegistryService.getInstance();
    const mcpService = McpService.getInstance();

    try {
      const parsed: Record<string, unknown> = JSON.parse(raw);
      const addedIds: string[] = [];

      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        // Shape A: full VS Code config
        const file = parsed as unknown as IMcpServersFile;
        for (const [id, config] of Object.entries(file.mcpServers)) {
          mcpServerConfigSchema.parse(config);
          await mcpRegistry.addServerAsync(id, config);
          addedIds.push(id);
        }
      } else if (typeof parsed.name === "string") {
        // Shape B: single server with "name" field
        const id = parsed.name;
        const config: Record<string, unknown> = { ...parsed };
        delete config.name;

        mcpServerConfigSchema.parse(config);
        await mcpRegistry.addServerAsync(id, config as IMcpServerConfig);
        addedIds.push(id);
      } else {
        await ctx.reply(
          "Invalid format. Server entry must have a \"name\" field, or wrap in {\"mcpServers\":{...}}.\n" +
          "Use /add_mcp_server without arguments to see examples.",
        );
        return;
      }

      await mcpService.refreshAsync();
      const results = mcpService.getServerResults();

      const replyLines: string[] = [];
      for (const id of addedIds) {
        const result = results.get(id);
        if (result?.error) {
          replyLines.push(`❌ "${id}": ${result.error}`);
        } else {
          replyLines.push(
            `✅ "${id}" added (${result?.loadedToolNames.length ?? 0} tools)`,
          );
          if (result && result.warnings.length > 0) {
            replyLines.push(`  ⚠️ ${result.warnings.join("\n  ⚠️ ")}`);
          }
        }
      }

      await ctx.reply(replyLines.join("\n"));
      logger.info("MCP server(s) added via Telegram", { addedIds });
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      await ctx.reply(`Failed to add MCP server: ${errorMessage}`);
      logger.error("Failed to add MCP server via Telegram", { error: errorMessage });
    }
  });

  // /list_mcp_servers command
  bot.command("list_mcp_servers", async (ctx: Context): Promise<void> => {
    const mcpRegistry = McpRegistryService.getInstance();
    const mcpService = McpService.getInstance();
    const servers = mcpRegistry.getAllServers();
    const results = mcpService.getServerResults();

    if (servers.length === 0) {
      await ctx.reply("No MCP servers configured. Use /add_mcp_server to add one.");
      return;
    }

    const lines: string[] = ["🔧 MCP Servers:\n"];
    for (const server of servers) {
      const result = results.get(server.id);
      const statusIcon = result?.error ? "❌" : result ? "✅" : "⏸️";
      const transportIcon = server.transport === "stdio" ? "📟" : "🌐";

      lines.push(`${statusIcon} ${transportIcon} "${server.id}"`);
      if (result?.loadedToolNames && result.loadedToolNames.length > 0) {
        lines.push(`  Tools: ${result.loadedToolNames.join(", ")}`);
      }
      if (result?.warnings && result.warnings.length > 0) {
        lines.push(`  ⚠️ ${result.warnings.length} warning(s)`);
      }
      if (result?.error) {
        lines.push(`  Error: ${result.error}`);
      }
    }

    await ctx.reply(lines.join("\n"));
  });

  // /remove_mcp_server command
  bot.command("remove_mcp_server", async (ctx: Context): Promise<void> => {
    const id: string = (typeof ctx.match === "string" ? ctx.match : "").trim();

    if (!id) {
      await ctx.reply("Usage: /remove_mcp_server <server-id>");
      return;
    }

    const mcpRegistry = McpRegistryService.getInstance();
    const mcpService = McpService.getInstance();

    const removed = await mcpRegistry.removeServerAsync(id);

    if (!removed) {
      await ctx.reply(`MCP server "${id}" not found.`);
      return;
    }

    await mcpService.refreshAsync();
    await ctx.reply(`✅ MCP server "${id}" removed.`);
    logger.info("MCP server removed via Telegram", { id });
  });

  // /mcp_status command
  bot.command("mcp_status", async (ctx: Context): Promise<void> => {
    const mcpService = McpService.getInstance();
    const tools = mcpService.getTools();
    const results = mcpService.getServerResults();

    const lines: string[] = ["🔧 MCP Status:\n"];
    lines.push(`Connected servers: ${results.size}`);
    lines.push(`Total tools: ${Object.keys(tools).length}`);

    if (results.size > 0) {
      lines.push("");
      for (const [serverId, result] of results) {
        if (result.error) {
          lines.push(`❌ ${serverId}: ${result.error}`);
        } else {
          lines.push(`✅ ${serverId}: ${result.loadedToolNames.length} tools`);
        }
      }
    }

    await ctx.reply(lines.join("\n"));
  });
}

//#endregion Telegram Commands
