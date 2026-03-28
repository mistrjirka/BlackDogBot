import "./env.js";
import { ConfigService } from "./services/config.service.js";
import { LoggerService } from "./services/logger.service.js";
import { EmbeddingService } from "./services/embedding.service.js";
import { VectorStoreService } from "./services/vector-store.service.js";
import { SkillLoaderService } from "./services/skill-loader.service.js";
import { SchedulerService } from "./services/scheduler.service.js";
import { MessagingService } from "./services/messaging.service.js";
import { ChannelRegistryService } from "./services/channel-registry.service.js";
import { McpRegistryService } from "./services/mcp-registry.service.js";
import { LangchainMcpService } from "./services/langchain-mcp.service.js";
import { PromptService } from "./services/prompt.service.js";
import { AiCapabilityService } from "./services/ai-capability.service.js";
import * as toolRegistry from "./helpers/tool-registry.js";
import * as skillInstaller from "./helpers/skill-installer.js";
import * as skillState from "./helpers/skill-state.js";
import type { IChatAgent } from "./agent/agent-interface.js";
import { LangchainMainAgent } from "./agent/langchain-main-agent.js";
import { LangchainCronExecutor } from "./agent/langchain-cron-executor.js";
import { telegramPlatform } from "./platforms/telegram/index.js";
import { discordPlatform } from "./platforms/discord/index.js";
import type { IPlatformDeps } from "./platforms/types.js";
import type { IConfig, IScheduledTask } from "./shared/types/index.js";
import { ensureAllDirectoriesAsync } from "./utils/paths.js";
import { executeCronTaskAsync } from "./executors/cron-task-executor.js";
import { extractErrorMessage } from "./utils/error.js";
import { TelegramHandler } from "./platforms/telegram/handler.js";
import type { SkillInstallKind } from "./helpers/skill-installer.js";
import { notifySchedulerChannelsWithDedupAsync } from "./utils/scheduler-notifications.js";
//#region Main

async function mainAsync(): Promise<void> {
  // 1. Load config
  const configService: ConfigService = ConfigService.getInstance();

  await configService.initializeAsync();

  let config: IConfig = configService.getConfig();

  // Initialize AiCapabilityService with AI config
  AiCapabilityService.getInstance().initialize(config.ai);

  // 2. Initialize logger
  const logger: LoggerService = LoggerService.getInstance();

  await logger.initializeAsync(config.logging.level);

  // Ensure runtime directories exist (including sessions/) before agents start.
  await ensureAllDirectoriesAsync();

  // 5. Initialize embeddings and vector store (only if embeddingProvider is explicitly configured)
  const embeddingProvider = config.knowledge.embeddingProvider;

  if (embeddingProvider) {
    const embeddingService: EmbeddingService = EmbeddingService.getInstance();
    const embeddingOpenRouterApiKey: string | undefined =
      config.knowledge.embeddingOpenRouterApiKey ?? config.ai.openrouter?.apiKey;

    await embeddingService.initializeAsync(
      config.knowledge.embeddingModelPath,
      config.knowledge.embeddingDtype,
      config.knowledge.embeddingDevice,
      embeddingProvider,
      config.knowledge.embeddingOpenRouterModel,
      embeddingOpenRouterApiKey,
    );

    logger.info("Embedding service initialized.");

    const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

    await vectorStoreService.initializeAsync(
      config.knowledge.lancedbPath,
      embeddingService.getDimension(),
    );

    logger.info("Vector store initialized.");

    logger.info("Knowledge helpers initialized.");
  } else {
    logger.info("Knowledge features disabled (embeddingProvider not configured).");
  }

  // 6. Initialize skill loader
  const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();
  const skipOsCheck = config.skills.skipOsCheck ?? false;

  await skillLoaderService.loadAllSkillsAsync(config.skills.directories, skipOsCheck);

  logger.info("Skill loader initialized.", {
    skillCount: skillLoaderService.getAllSkills().length,
  });

  // 7. Initialize messaging service
  const messagingService: MessagingService = MessagingService.getInstance();

  logger.info("Messaging service initialized.");

  // 7.5. Initialize channel registry (for permissions and notifications)
  const channelRegistry = ChannelRegistryService.getInstance();
  await channelRegistry.initializeAsync();

  logger.info("Channel registry initialized.", {
    channelCount: channelRegistry.getAllChannels().length,
    notificationChannelCount: channelRegistry.getNotificationChannels().length,
  });

  // 7.6. Initialize MCP server registry and connect to servers
  const mcpRegistry = McpRegistryService.getInstance();
  await mcpRegistry.initializeAsync();

  const mcpService = LangchainMcpService.getInstance();
  await mcpService.refreshAsync();

  const mcpResults = mcpService.getServerResults();
  for (const [serverId, result] of mcpResults) {
    if (result.error) {
      logger.warn("MCP server connection failed", { serverId, error: result.error });
    } else {
      logger.info("MCP server connected", {
        serverId,
        tools: result.loadedToolNames.length,
        warnings: result.warnings.length,
      });
    }
  }

  const notifyAllChannelsAsync = async (
    message: string,
    errorPrefix: string,
  ): Promise<void> => {
    const notificationChannels = channelRegistry.getNotificationChannels();

    for (const channel of notificationChannels) {
      try {
        const sender = messagingService.createSenderForChat(channel.platform, channel.channelId);
        await sender(message);
      } catch (sendError: unknown) {
        logger.error(`${errorPrefix} ${channel.platform}:${channel.channelId}`, {
          error: extractErrorMessage(sendError),
        });
      }
    }
  };

  const notifySchedulerChannelsAsync = async (
    message: string,
    errorPrefix: string,
    taskId?: string,
    fallbackSuccessMessage?: string,
    fallbackFailureMessage?: string,
    logInvalidChannelWarning?: boolean,
  ): Promise<void> => {
    const notificationChannels = channelRegistry.getNotificationChannels();

    await notifySchedulerChannelsWithDedupAsync(
      notificationChannels,
      message,
      {
        errorPrefix,
        taskId,
        fallbackSuccessMessage,
        fallbackFailureMessage,
        logInvalidChannelWarning,
      },
      {
        hasAdapter: (platform) => messagingService.hasAdapter(platform),
        sendToChannelAsync: async (platform, channelId, outgoingMessage): Promise<void> => {
          const sender = messagingService.createSenderForChat(platform, channelId);
          await sender(outgoingMessage);
        },
        getKnownTelegramChatIds: (): string[] => TelegramHandler.getInstance().getKnownChatIds(),
        logger,
      },
    );
  };

  // 7.6. Auto-setup skills with missing dependencies
  const skillsConfig = config.skills;
  const autoSetup = skillsConfig.autoSetup ?? true;
  const autoSetupNotify = skillsConfig.autoSetupNotify ?? true;
  const allowedInstallKinds = skillsConfig.allowedInstallKinds ?? ["brew", "node", "go", "uv"];
  const installTimeout = skillsConfig.installTimeout ?? 300000;

  if (autoSetup) {
    const skillsNeedingSetup = skillLoaderService.getAllSkills().filter(
      (skill) => skill.state.state === "needs-setup"
    );

    if (skillsNeedingSetup.length > 0) {
      logger.info(`Auto-setting up ${skillsNeedingSetup.length} skills...`);

      for (const skill of skillsNeedingSetup) {
        try {
          logger.info(`Setting up skill "${skill.name}"...`);

          await skillState.markSkillSetupInProgressAsync(skill.name);

          const installSteps = skill.frontmatter.metadata?.openclaw?.install || [];
          const result = await skillInstaller.executeSkillInstallStepsAsync(
            installSteps,
            allowedInstallKinds as SkillInstallKind[],
            installTimeout
          );

          if (result.success) {
            await skillState.markSkillSetupCompleteAsync(skill.name);
            logger.info(`Skill "${skill.name}" setup completed`, { installed: result.installed });

            if (autoSetupNotify) {
              const notifyMessage =
                `✅ **Skill Ready**: \`${skill.name}\`\n\n` +
                (result.installed.length > 0 ? `**Installed:** ${result.installed.join(", ")}` : "");
              await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
            }
          } else if (result.manualStepsRequired.length > 0) {
            await skillState.markSkillNeedsSetupAsync(
              skill.name,
              skill.state.missingDeps,
              result.manualStepsRequired
            );
            logger.info(`Skill "${skill.name}" requires manual steps`, {
              manualSteps: result.manualStepsRequired,
            });

            if (autoSetupNotify) {
              const notifyMessage =
                `⚠️ **Skill Needs Manual Setup**: \`${skill.name}\`\n\n` +
                `This skill requires packages that cannot be auto-installed.\n\n` +
                `**Manual steps:**\n${result.manualStepsRequired.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
                `After completing these steps, restart BlackDogBot or use the setup-skill tool.`;
              await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
            }
          } else {
            await skillState.markSkillSetupErrorAsync(skill.name, result.error || "Unknown error");
            logger.error(`Skill "${skill.name}" setup failed`, { error: result.error });

            if (autoSetupNotify) {
              const notifyMessage =
                `❌ **Skill Setup Failed**: \`${skill.name}\`\n\n` +
                `**Error:**\n\`\`\`\n${result.error}\n\`\`\`\n\n` +
                `Will retry on next startup.`;
              await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
            }
          }
        } catch (setupError) {
          const errorMsg = setupError instanceof Error ? setupError.message : String(setupError);
          await skillState.markSkillSetupErrorAsync(skill.name, errorMsg);
          logger.error(`Skill "${skill.name}" setup threw error`, { error: errorMsg });

          if (autoSetupNotify) {
            const notifyMessage =
              `❌ **Skill Setup Failed**: \`${skill.name}\`\n\n` +
              `**Error:**\n\`\`\`\n${errorMsg}\n\`\`\`\n\n` +
              `Will retry on next startup.`;
            await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
          }
        }
      }
    }
  }

  // 8.4. Initialize PromptService (required by LangchainMainAgent)
  const promptService = PromptService.getInstance();
  await promptService.initializeAsync();

  // 8.5. Initialize LangchainMainAgent
  const langchainMainAgent = LangchainMainAgent.getInstance();
  await langchainMainAgent.initializeAsync();

  // 8. Initialize platform dependencies
  const chatAgent: IChatAgent = langchainMainAgent as IChatAgent;
  const platformDeps: IPlatformDeps = {
    agent: chatAgent,
    channelRegistry,
    messagingService,
    toolRegistry,
    logger,
  };

  // 8.5. Initialize Telegram bot (if configured)
  if (config.telegram && telegramPlatform.isEnabled?.(config.telegram)) {
    await telegramPlatform.initialize(config.telegram, platformDeps);
    logger.info("Telegram bot initialized.");
  } else {
    logger.warn("Telegram not configured. Bot will not start.");
  }

  // 8.6. Initialize Discord bot (if configured)
  if (config.discord && discordPlatform.isEnabled?.(config.discord)) {
    await discordPlatform.initialize(config.discord, platformDeps);
    logger.info("Discord bot initialized.");
  } else {
    logger.info("Discord not configured. Bot will not start.");
  }

  // 9. Initialize scheduler (if enabled)
  const schedulerService: SchedulerService = SchedulerService.getInstance();

  if (config.scheduler.enabled) {
    const cronExecutor = LangchainCronExecutor.getInstance();

    schedulerService.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      // Helper: broadcast to all channels with receiveNotifications=true
      const broadcastToNotificationChannelsAsync = async (message: string): Promise<void> => {
        const notificationChannels = channelRegistry.getNotificationChannels();

        if (notificationChannels.length === 0) {
          throw new Error(
            "No notification channels configured. " +
            "Use /notifications_enable in a Telegram or Discord channel, " +
            "or manually configure ~/.blackdogbot/channels.yaml"
          );
        }

        await notifySchedulerChannelsAsync(
          message,
          "Failed to send cron message to",
          task.taskId,
          "Sent notification via fallback chat ID",
          "Fallback send also failed",
          true,
        );
      };

      await executeCronTaskAsync(task, {
        broadcastToNotificationChannelsAsync,
        executeTaskAsync: cronExecutor.executeTaskAsync.bind(cronExecutor),
      });
    });

    schedulerService.setOnTaskFailure(async (task, error) => {
      const timestamp = new Date().toISOString();
      const message =
        `❌ **Task Failed**: \`${task.name}\`\n\n` +
        `**Time:** ${timestamp}\n` +
        `**Task ID:** \`${task.taskId}\`\n\n` +
        `**Error:**\n\`\`\`\n${error}\n\`\`\``;

      await notifySchedulerChannelsAsync(
        message,
        "Failed to send failure notification to",
        task.taskId,
        "Sent failure notification via fallback chat ID",
        "Fallback send also failed",
        true,
      );
    });

    schedulerService.setOnTaskSkipped(async (task, reason) => {
      const timestamp: string = new Date().toISOString();
      const message: string =
        `**Task Skipped**: \`${task.name}\`\n\n` +
        `**Time:** ${timestamp}\n` +
        `**Task ID:** \`${task.taskId}\`\n\n` +
        `**Reason:** ${reason}`;

      await notifySchedulerChannelsAsync(
        message,
        "Failed to send task-skipped notification to",
        task.taskId,
        undefined,
        "Fallback send for task-skipped notification failed",
        false,
      );
    });

    await schedulerService.startAsync();

    logger.info("Scheduler started.");
  } else {
    logger.info("Scheduler disabled in config.");
  }

  // 11. Graceful shutdown
  const shutdownAsync = async (): Promise<void> => {
    logger.info("Shutdown signal received. Stopping BlackDogBot...");

    await LangchainMcpService.getInstance().closeAsync().catch(() => {});
    await telegramPlatform.stop();
    await discordPlatform.stop();

    if (config.scheduler.enabled) {
      await schedulerService.stopAsync();
    }

  };

  process.on("SIGTERM", (): void => {
    void shutdownAsync();
  });

  process.on("SIGINT", (): void => {
    void shutdownAsync();
  });
}

mainAsync().catch((error: unknown): void => {
  console.error("Fatal error starting BlackDogBot:", error);
  process.exit(1);
});
//#endregion Main
