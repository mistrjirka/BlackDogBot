import "./env.js";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { ConfigService } from "./services/config.service.js";
import { LoggerService } from "./services/logger.service.js";
import { AiProviderService } from "./services/ai-provider.service.js";
import { PromptService } from "./services/prompt.service.js";
import { EmbeddingService } from "./services/embedding.service.js";
import { VectorStoreService } from "./services/vector-store.service.js";
import { SkillLoaderService } from "./services/skill-loader.service.js";
import { SchedulerService } from "./services/scheduler.service.js";
import { MessagingService } from "./services/messaging.service.js";
import { JobStorageService } from "./services/job-storage.service.js";
import { ChannelRegistryService } from "./services/channel-registry.service.js";
import * as toolRegistry from "./helpers/tool-registry.js";
import * as skillInstaller from "./helpers/skill-installer.js";
import * as skillState from "./helpers/skill-state.js";
import { CronAgent } from "./agent/cron-agent.js";
import { MainAgent } from "./agent/main-agent.js";
import { BrainInterfaceService } from "./brain-interface/service.js";
import { StatusService } from "./services/status.service.js";
import { telegramPlatform } from "./platforms/telegram/index.js";
import { discordPlatform } from "./platforms/discord/index.js";
import type { IPlatformDeps } from "./platforms/types.js";
import type { IConfig, IScheduledTask, IExecutionContext } from "./shared/types/index.js";
import { getJobLogsDir, getBrainInterfaceTokenFilePath, ensureDirectoryExistsAsync } from "./utils/paths.js";
import { executeCronTaskAsync } from "./executors/cron-task-executor.js";
import { extractErrorMessage } from "./utils/error.js";
import { TelegramHandler } from "./platforms/telegram/handler.js";
import type { SkillInstallKind } from "./helpers/skill-installer.js";
import { generateJwtToken, type IJwtPayload } from "./utils/jwt.js";
import { notifySchedulerChannelsWithDedupAsync } from "./utils/scheduler-notifications.js";

const BRAIN_INTERFACE_PORT: number = parseInt(process.env.BRAIN_INTERFACE_PORT ?? "3001", 10);

function createBrainInterfaceJwtSecret(): string {
  return crypto.randomBytes(48).toString("base64url");
}

//#region Main

async function mainAsync(): Promise<void> {
  // 1. Load config
  const configService: ConfigService = ConfigService.getInstance();

  await configService.initializeAsync();

  let config: IConfig = configService.getConfig();

  let brainJwtSecret: string = config.brainInterface.jwtSecret;
  const brainJwtIssuer: string = config.brainInterface.jwtIssuer;
  const brainJwtAudience: string = config.brainInterface.jwtAudience;

  if (brainJwtSecret === "replace-with-generated-secret") {
    brainJwtSecret = createBrainInterfaceJwtSecret();
    await configService.updateConfigAsync({
      brainInterface: {
        jwtSecret: brainJwtSecret,
        jwtIssuer: brainJwtIssuer,
        jwtAudience: brainJwtAudience,
      },
    });
    config = configService.getConfig();
  }

  // 2. Initialize logger
  const logger: LoggerService = LoggerService.getInstance();

  await logger.initializeAsync(config.logging.level);

  const tokenFilePath: string = getBrainInterfaceTokenFilePath();
  const tokenDirPath: string = path.dirname(tokenFilePath);
  const nowEpochSeconds: number = Math.floor(Date.now() / 1000);
  const adminPayload: IJwtPayload = {
    iss: config.brainInterface.jwtIssuer,
    aud: config.brainInterface.jwtAudience,
    sub: "brain-interface-ui",
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + (60 * 60 * 24 * 365),
  };
  const adminToken: string = generateJwtToken(adminPayload, brainJwtSecret);

  await ensureDirectoryExistsAsync(tokenDirPath);
  await fs.writeFile(tokenFilePath, `${adminToken}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });

  // Enable CLI status output (spinner/status line)
  const statusService: StatusService = StatusService.getInstance();
  statusService.enableCliOutput(true);

  logger.info("BetterClaw daemon starting...");
  logger.info("BrainInterface JWT token is ready for UI login", {
    tokenFilePath,
    hint: "Paste this token into the Brain Interface auth field. It is persisted in browser localStorage.",
  });

  // 2.5. Catch unhandled promise rejections
  process.on("unhandledRejection", (reason: unknown): void => {
    logger.error("Unhandled promise rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // 2.6. Clean up orphaned jobs in "creating" status (from interrupted job creation)
  const jobStorageService: JobStorageService = JobStorageService.getInstance();
  const orphanedCount: number = await jobStorageService.cleanupOrphanedCreatingJobsAsync();

  if (orphanedCount > 0) {
    logger.info("Cleaned up orphaned jobs in 'creating' status", { count: orphanedCount });
  }

  // 3. Initialize prompt service
  const promptService: PromptService = PromptService.getInstance();

  await promptService.initializeAsync();

  logger.info("Prompt service initialized.");

  // 4. Initialize AI provider
  const aiProviderService: AiProviderService = AiProviderService.getInstance();

  await aiProviderService.initializeAsync(config.ai);

  logger.info("AI provider initialized.", { 
    provider: config.ai.provider,
    contextWindow: aiProviderService.getContextWindow(),
  });

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
                `After completing these steps, restart BetterClaw or use the setup-skill tool.`;
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

  // 8. Initialize platform dependencies
  const platformDeps: IPlatformDeps = {
    mainAgent: MainAgent.getInstance(),
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
    const cronAgent: CronAgent = CronAgent.getInstance();

    schedulerService.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      // Helper: broadcast to all channels with receiveNotifications=true
      const broadcastToNotificationChannelsAsync = async (message: string): Promise<void> => {
        const notificationChannels = channelRegistry.getNotificationChannels();

        if (notificationChannels.length === 0) {
          throw new Error(
            "No notification channels configured. " +
            "Use /notifications_enable in a Telegram or Discord channel, " +
            "or manually configure ~/.betterclaw/channels.yaml"
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

      const executionContext: IExecutionContext = { toolCallHistory: [] };

      await executeCronTaskAsync(task, {
        broadcastToNotificationChannelsAsync,
        broadcastCronMessage: (name: string, msg: string) =>
          BrainInterfaceService.getInstance().broadcastCronMessage(name, msg),
        logInfo: (msg: string, meta?: Record<string, unknown>) => logger.info(msg, meta),
        executeTaskAsync: (t, sender, taskIdProvider) =>
          cronAgent.executeTaskAsync(t, sender, taskIdProvider, executionContext),
        openJobLogAsync: (key, path) => logger.openJobLogAsync(key, path),
        closeJobLog: (key) => logger.closeJobLog(key),
        getJobLogPath: (name, ts) =>
          `${getJobLogsDir()}/${name.replace(/[^a-zA-Z0-9_-]/g, "_")}-${ts}.log`,
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

  // 10. Initialize BrainInterface (WebSocket server for debug UI)
  const httpServer = createServer();
  const io: SocketIOServer = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const brainInterface: BrainInterfaceService = BrainInterfaceService.getInstance();
  brainInterface.initialize(
    io,
    brainJwtSecret,
    config.brainInterface.jwtIssuer,
    config.brainInterface.jwtAudience,
  );

  await new Promise<void>((resolve): void => {
    httpServer.listen(BRAIN_INTERFACE_PORT, (): void => {
      resolve();
    });
  });

  logger.info("BrainInterface WebSocket server started.", { port: BRAIN_INTERFACE_PORT });

  logger.info("BetterClaw daemon is running.");

  // 11. Graceful shutdown
  const shutdownAsync = async (): Promise<void> => {
    logger.info("Shutdown signal received. Stopping BetterClaw...");

    await telegramPlatform.stop();
    await discordPlatform.stop();

    if (config.scheduler.enabled) {
      await schedulerService.stopAsync();
    }

    await new Promise<void>((resolve): void => {
      io.close((): void => {
        resolve();
      });
    });

    logger.info("BetterClaw stopped. Goodbye.");
    process.exit(0);
  };

  process.on("SIGTERM", (): void => {
    void shutdownAsync();
  });

  process.on("SIGINT", (): void => {
    void shutdownAsync();
  });
}

mainAsync().catch((error: unknown): void => {
  console.error("Fatal error starting BetterClaw:", error);
  process.exit(1);
});
//#endregion Main
