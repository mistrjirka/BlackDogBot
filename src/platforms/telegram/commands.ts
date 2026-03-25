import { Context, Bot } from "grammy";

import { LoggerService } from "../../services/logger.service.js";
import { PromptService } from "../../services/prompt.service.js";
import { LangchainMainAgent } from "../../agent/langchain-main-agent.js";
import type { IRefreshSessionsResult } from "../../agent/types.js";
import { ChannelRegistryService } from "../../services/channel-registry.service.js";
import { McpRegistryService } from "../../services/mcp-registry.service.js";
import { McpService } from "../../services/mcp.service.js";
import { AiProviderService } from "../../services/ai-provider.service.js";
import { ConfigService } from "../../services/config.service.js";
import { TelegramHandler } from "./handler.js";
import { factoryResetAsync, type IFactoryResetResult } from "../../services/factory-reset.service.js";
import { extractErrorMessage } from "../../utils/error.js";
import type { IMcpServerConfig, IMcpServersFile } from "../../shared/types/mcp.types.js";
import { mcpServerConfigSchema } from "../../shared/schemas/mcp.schemas.js";
import type {
  AiProvider,
  IAiConfig,
  IAiFallbackEntry,
  IProviderCapabilitySummary,
  IProviderModelListEntry,
  IRateLimitConfig,
} from "../../shared/types/index.js";

//#region Telegram Commands

/**
 * Set up Telegram bot commands.
 * Handles /start, /help, /clear, /reset, /factory_reset, /notifications_enable, /notifications_disable, /status
 */
export function setupTelegramCommands(bot: Bot): void {
  const logger = LoggerService.getInstance();
  const channelRegistry = ChannelRegistryService.getInstance();
  const promptService = PromptService.getInstance();
  const mainAgent = LangchainMainAgent.getInstance();
  const telegramHandler = TelegramHandler.getInstance();

  // /start command
  bot.command("start", async (ctx: Context): Promise<void> => {
    await ctx.reply("BlackDogBot is ready. Send me a message to get started.");
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
      "/models — Show active model/provider and model command help",
      "/models list [provider] [filter] — List tool-capable models",
      "/models switch <provider> [model] — Switch primary provider/model",
      "/models add <provider> ... — Add or update provider config",
      "/models fallback list — Show fallback chain",
      "/models fallback add <provider> [model] — Add fallback provider",
      "/models fallback remove <provider> — Remove fallback provider",
      "/models fallback swap — Swap primary with first fallback",
      "/models reset — Reset runtime provider back to primary",
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
      const refreshResult: IRefreshSessionsResult = await mainAgent.refreshAllSessionsAsync();

      const refreshSummary: string = refreshResult.failedCount > 0
        ? `Main sessions refreshed: ${refreshResult.refreshedCount}, failed: ${refreshResult.failedCount}.`
        : `Main sessions refreshed: ${refreshResult.refreshedCount}.`;

      await ctx.reply(`All prompts have been updated from source defaults. ${refreshSummary}`);
      logger.info("Prompts updated from source defaults via /update_prompts command.", {
        refreshedCount: refreshResult.refreshedCount,
        failedCount: refreshResult.failedCount,
        failedChatIds: refreshResult.failedChatIds,
      });
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

  // /models command
  bot.command("models", async (ctx: Context): Promise<void> => {
    const raw: string = (typeof ctx.match === "string" ? ctx.match : "").trim();
    const parts: string[] = raw.length > 0 ? raw.split(/\s+/g) : [];

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const configService: ConfigService = ConfigService.getInstance();
    const aiConfig: IAiConfig = configService.getAiConfig();

    try {

    if (parts.length === 0 || parts[0] === "status") {
      const activeProvider: AiProvider = aiProviderService.getActiveProvider();
      const primaryProvider: AiProvider = aiProviderService.getPrimaryProvider();
      const fallbackChain: IAiFallbackEntry[] = aiProviderService.getFallbackChain();

      const lines: string[] = [
        "AI Model Management",
        "",
        `Active provider: ${activeProvider}`,
        `Primary provider: ${primaryProvider}`,
        `Active model: ${aiProviderService.getActiveModelId()}`,
        `Structured mode: ${aiProviderService.getStructuredOutputMode()}`,
        `Vision support: ${aiProviderService.getSupportsVision() ? "yes" : "no"}`,
        "",
        "Configured providers:",
      ];

      if (aiConfig.openrouter) {
        lines.push(
          `- openrouter: model=${aiConfig.openrouter.model}, key=${aiProviderService.maskApiKey(aiConfig.openrouter.apiKey)}`,
        );
      }
      if (aiConfig.openaiCompatible) {
        lines.push(
          `- openai-compatible: model=${aiConfig.openaiCompatible.model}, baseUrl=${aiConfig.openaiCompatible.baseUrl}, key=${aiProviderService.maskApiKey(aiConfig.openaiCompatible.apiKey)}`,
        );
      }
      if (aiConfig.lmStudio) {
        lines.push(
          `- lm-studio: model=${aiConfig.lmStudio.model}, baseUrl=${aiConfig.lmStudio.baseUrl}, key=${aiProviderService.maskApiKey(aiConfig.lmStudio.apiKey)}`,
        );
      }

      lines.push("");
      lines.push("Fallback chain:");
      if (fallbackChain.length === 0) {
        lines.push("- (none)");
      } else {
        for (const entry of fallbackChain) {
          lines.push(`- ${entry.provider}${entry.model ? ` (${entry.model})` : ""}`);
        }
      }

      lines.push("");
      lines.push("Usage:");
      lines.push("/models list [provider] [filter]");
      lines.push("/models switch <provider> [model]");
      lines.push("/models add <provider> ...");
      lines.push("/models fallback list");
      lines.push("/models fallback add <provider> [model]");
      lines.push("/models fallback remove <provider>");
      lines.push("/models fallback swap");
      lines.push("/models reset");

      await _replyInChunksAsync(ctx, lines.join("\n"));
      return;
    }

    if (parts[0] === "list") {
      const currentProvider: AiProvider = aiProviderService.getActiveProvider();
      const parsedProvider: AiProvider | null = parts[1] ? _parseProvider(parts[1]) : null;

      const provider: AiProvider = parsedProvider ?? currentProvider;
      const filterStartIndex: number = parsedProvider ? 2 : 1;
      const rawFilter: string = parts.slice(filterStartIndex).join(" ").trim();
      const filter: string | undefined = rawFilter.length > 0 && rawFilter.toLowerCase() !== "all"
        ? rawFilter
        : undefined;

      const models: IProviderModelListEntry[] = await aiProviderService.listModelsAsync(provider, filter);

      if (models.length === 0) {
        await ctx.reply(`No tool-capable models found for provider ${provider}${filter ? ` with filter "${filter}"` : ""}.`);
        return;
      }

      const lines: string[] = [
        `Models (${provider})`,
        `Only models with tool calling support are shown. Total: ${models.length}`,
        "",
      ];

      for (const model of models) {
        const contextWindow: string = model.contextWindow !== null ? String(model.contextWindow) : "?";
        const promptPrice: string = model.promptPrice ?? "?";
        const completionPrice: string = model.completionPrice ?? "?";

        lines.push(
          `- ${model.id} | ctx=${contextWindow} | in=${promptPrice} | out=${completionPrice}`,
        );
      }

      await _replyInChunksAsync(ctx, lines.join("\n"));
      return;
    }

    if (parts[0] === "switch") {
      const providerArg: string | undefined = parts[1];
      if (!providerArg) {
        await ctx.reply("Usage: /models switch <provider> [model]");
        return;
      }

      const provider: AiProvider | null = _parseProvider(providerArg);
      if (!provider) {
        await ctx.reply(`Unknown provider: ${providerArg}`);
        return;
      }

      const modelOverride: string | undefined = parts.slice(2).join(" ").trim() || undefined;
      const summary: IProviderCapabilitySummary = await aiProviderService.switchPrimaryProviderAsync(provider, modelOverride);

      await ctx.reply(_formatCapabilitySummary(summary, "Primary provider switched and persisted to config.yaml."));
      return;
    }

    if (parts[0] === "add") {
      const providerArg: string | undefined = parts[1];
      if (!providerArg) {
        await ctx.reply(_getModelsAddUsageText());
        return;
      }

      const provider: AiProvider | null = _parseProvider(providerArg);
      if (!provider) {
        await ctx.reply(`Unknown provider: ${providerArg}`);
        return;
      }

      const args: string[] = parts.slice(2);
      const configPatch: Record<string, unknown> = _buildProviderPatch(provider, args);

      await aiProviderService.addOrUpdateProviderConfigAsync(provider, configPatch);

      const modelForProbe: string = String(configPatch.model ?? "");
      if (modelForProbe.trim().length === 0) {
        throw new Error("Provider model is required.");
      }
      const summary: IProviderCapabilitySummary = await aiProviderService.probeCapabilitiesForProviderModelAsync(provider, modelForProbe);
      await ctx.reply(_formatCapabilitySummary(summary, `Provider ${provider} saved to config.yaml.`));
      return;
    }

    if (parts[0] === "fallback") {
      const action: string | undefined = parts[1];

      if (!action || action === "list") {
        const chain: IAiFallbackEntry[] = aiProviderService.getFallbackChain();
        const lines: string[] = ["Fallback chain:"];

        if (chain.length === 0) {
          lines.push("- (none)");
        } else {
          for (const entry of chain) {
            lines.push(`- ${entry.provider}${entry.model ? ` (${entry.model})` : ""}`);
          }
        }

        await ctx.reply(lines.join("\n"));
        return;
      }

      if (action === "add") {
        const providerArg: string | undefined = parts[2];
        if (!providerArg) {
          await ctx.reply("Usage: /models fallback add <provider> [model]");
          return;
        }

        const provider: AiProvider | null = _parseProvider(providerArg);
        if (!provider) {
          await ctx.reply(`Unknown provider: ${providerArg}`);
          return;
        }

        const modelOverride: string | undefined = parts.slice(3).join(" ").trim() || undefined;
        const summary: IProviderCapabilitySummary = await aiProviderService.addFallbackAsync(provider, modelOverride);
        await ctx.reply(_formatCapabilitySummary(summary, `Fallback provider ${provider} saved to config.yaml.`));
        return;
      }

      if (action === "remove") {
        const providerArg: string | undefined = parts[2];
        if (!providerArg) {
          await ctx.reply("Usage: /models fallback remove <provider>");
          return;
        }

        const provider: AiProvider | null = _parseProvider(providerArg);
        if (!provider) {
          await ctx.reply(`Unknown provider: ${providerArg}`);
          return;
        }

        await aiProviderService.removeFallbackAsync(provider);
        await ctx.reply(`Fallback provider ${provider} removed and config persisted.`);
        return;
      }

      if (action === "swap") {
        const summary: IProviderCapabilitySummary = await aiProviderService.swapPrimaryWithFirstFallbackAsync();
        await ctx.reply(_formatCapabilitySummary(summary, "Primary and first fallback swapped. Changes persisted."));
        return;
      }

      await ctx.reply("Usage: /models fallback [list|add|remove|swap]");
      return;
    }

    if (parts[0] === "reset") {
      await aiProviderService.resetToPrimaryProviderAsync();
      await ctx.reply("Runtime provider reset to primary. Next request uses the primary provider.");
      return;
    }

      await ctx.reply(
        "Unknown /models subcommand. Use: status, list, switch, add, fallback, reset.",
      );
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      await ctx.reply(`Model command failed: ${errorMessage}`);
      logger.error("Failed to process /models command", {
        error: errorMessage,
        args: raw,
      });
    }
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

function _parseProvider(raw: string): AiProvider | null {
  const value: string = raw.trim().toLowerCase();

  if (value === "openrouter") {
    return "openrouter";
  }

  if (value === "openai-compatible" || value === "openai" || value === "openai_compatible") {
    return "openai-compatible";
  }

  if (value === "lm-studio" || value === "lmstudio") {
    return "lm-studio";
  }

  return null;
}

function _formatCapabilitySummary(summary: IProviderCapabilitySummary, prefix: string): string {
  return [
    prefix,
    `Provider: ${summary.provider}`,
    `Model: ${summary.model}`,
    `Tool calling: ${summary.supportsToolCalling ? "yes" : "no"}`,
    `Structured outputs: ${summary.supportsStructuredOutputs ? "yes" : "no"}`,
    `Vision: ${summary.supportsVision ? "yes" : "no"}`,
    `Structured mode: ${summary.structuredOutputMode}`,
    `Context window: ${summary.contextWindow}`,
  ].join("\n");
}

function _getModelsAddUsageText(): string {
  return [
    "Usage:",
    "/models add openrouter <apiKey> <model>",
    "/models add openai-compatible <baseUrl> <apiKey> <model>",
    "/models add lm-studio <baseUrl> <model> [apiKey]",
  ].join("\n");
}

function _buildProviderPatch(provider: AiProvider, args: string[]): Record<string, unknown> {
  if (provider === "openrouter") {
    if (args.length < 2) {
      throw new Error("Usage: /models add openrouter <apiKey> <model>");
    }

    const rateLimits: IRateLimitConfig = { rpm: 60, tpm: 100000 };
    return {
      apiKey: args[0],
      model: args.slice(1).join(" "),
      rateLimits,
    };
  }

  if (provider === "openai-compatible") {
    if (args.length < 3) {
      throw new Error("Usage: /models add openai-compatible <baseUrl> <apiKey> <model>");
    }

    const rateLimits: IRateLimitConfig = { rpm: 120, tpm: 200000, maxConcurrent: 1 };
    return {
      baseUrl: args[0],
      apiKey: args[1],
      model: args.slice(2).join(" "),
      rateLimits,
    };
  }

  if (args.length < 2) {
    throw new Error("Usage: /models add lm-studio <baseUrl> <model> [apiKey]");
  }

  const rateLimits: IRateLimitConfig = { rpm: 120, tpm: 200000, maxConcurrent: 1 };
  return {
    baseUrl: args[0],
    model: args[1],
    ...(args[2] ? { apiKey: args[2] } : {}),
    rateLimits,
  };
}

async function _replyInChunksAsync(ctx: Context, text: string): Promise<void> {
  const maxChunkLength: number = 3500;
  const lines: string[] = text.split("\n");

  let currentChunk: string = "";

  for (const line of lines) {
    const next: string = currentChunk.length === 0 ? line : `${currentChunk}\n${line}`;

    if (next.length <= maxChunkLength) {
      currentChunk = next;
      continue;
    }

    if (currentChunk.length > 0) {
      await ctx.reply(currentChunk);
    }

    currentChunk = line;
  }

  if (currentChunk.length > 0) {
    await ctx.reply(currentChunk);
  }
}

//#endregion Telegram Commands
