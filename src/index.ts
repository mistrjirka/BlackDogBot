import "./env.js";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { ConfigService } from "./services/config.service.js";
import { LoggerService } from "./services/logger.service.js";
import { AiProviderService } from "./services/ai-provider.service.js";
import { PromptService } from "./services/prompt.service.js";
import { EmbeddingService } from "./services/embedding.service.js";
import { VectorStoreService } from "./services/vector-store.service.js";
import { KnowledgeService } from "./services/knowledge.service.js";
import { SkillLoaderService } from "./services/skill-loader.service.js";
import { SchedulerService } from "./services/scheduler.service.js";
import { MessagingService } from "./services/messaging.service.js";
import { JobStorageService } from "./services/job-storage.service.js";
import { ChannelRegistryService } from "./services/channel-registry.service.js";
import { ToolRegistryService } from "./services/tool-registry.service.js";
import { CronAgent } from "./agent/cron-agent.js";
import { MainAgent } from "./agent/main-agent.js";
import { BrainInterfaceService } from "./brain-interface/service.js";
import { StatusService } from "./services/status.service.js";
import { telegramPlatform } from "./platforms/telegram/index.js";
import { discordPlatform } from "./platforms/discord/index.js";
import type { IPlatformDeps } from "./platforms/types.js";
import type { IConfig, IScheduledTask } from "./shared/types/index.js";
import { getJobLogsDir } from "./utils/paths.js";
import { executeCronTaskAsync } from "./executors/cron-task-executor.js";
import { TelegramHandler } from "./platforms/telegram/handler.js";

const BRAIN_INTERFACE_PORT: number = parseInt(process.env.BRAIN_INTERFACE_PORT ?? "3001", 10);

//#region Main

async function mainAsync(): Promise<void> {
  // 1. Load config
  const configService: ConfigService = ConfigService.getInstance();

  await configService.initializeAsync();

  const config: IConfig = configService.getConfig();

  // 2. Initialize logger
  const logger: LoggerService = LoggerService.getInstance();

  await logger.initializeAsync(config.logging.level);

  // Enable CLI status output (spinner/status line)
  const statusService: StatusService = StatusService.getInstance();
  statusService.enableCliOutput(true);

  logger.info("BetterClaw daemon starting...");

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

  // 5. Initialize embeddings and vector store
  const embeddingService: EmbeddingService = EmbeddingService.getInstance();

  await embeddingService.initializeAsync(
    config.knowledge.embeddingModelPath,
    config.knowledge.embeddingDtype,
    config.knowledge.embeddingDevice,
  );

  logger.info("Embedding service initialized.");

  const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();

  await vectorStoreService.initializeAsync(config.knowledge.lancedbPath);

  logger.info("Vector store initialized.");

  // Initialize knowledge service
  KnowledgeService.getInstance();

  logger.info("Knowledge service initialized.");

  // 6. Initialize skill loader
  const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();

  await skillLoaderService.loadAllSkillsAsync(config.skills.directories);

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

  // 8. Initialize platform dependencies
  const platformDeps: IPlatformDeps = {
    mainAgent: MainAgent.getInstance(),
    channelRegistry,
    messagingService,
    toolRegistry: ToolRegistryService.getInstance(),
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
      const notificationChatId: string | null = config.scheduler.notificationChatId;

      // Helper: deliver a message to Telegram (backward compat)
      const sendToTelegramAsync = async (message: string): Promise<void> => {
        if (!config.telegram) return;

        if (notificationChatId) {
          await messagingService.createSenderForChat("telegram", notificationChatId)(message);
        } else {
          const knownChatIds = TelegramHandler.getInstance().getKnownChatIds();
          for (const chatId of knownChatIds) {
            try {
              await messagingService.createSenderForChat("telegram", chatId)(message);
            } catch (error) {
              logger.warn(`Failed to send cron message to chat ${chatId}`, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      };

      // Helper: broadcast to all channels with receiveNotifications=true
      const broadcastToNotificationChannelsAsync = async (message: string): Promise<void> => {
        const notificationChannels = channelRegistry.getNotificationChannels();

        if (notificationChannels.length === 0) {
          // Fall back to legacy Telegram behavior if no channels configured
          await sendToTelegramAsync(message);
          return;
        }

        for (const channel of notificationChannels) {
          try {
            const sender = messagingService.createSenderForChat(channel.platform, channel.channelId);
            await sender(message);
          } catch (error) {
            logger.warn(`Failed to send cron message to ${channel.platform}:${channel.channelId}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };

      await executeCronTaskAsync(task, {
        sendToTelegramAsync,
        broadcastToNotificationChannelsAsync,
        broadcastCronMessage: (name: string, msg: string) =>
          BrainInterfaceService.getInstance().broadcastCronMessage(name, msg),
        logInfo: (msg: string, meta?: Record<string, unknown>) => logger.info(msg, meta),
        executeTaskAsync: (t, sender) => cronAgent.executeTaskAsync(t, sender),
        openJobLogAsync: (key, path) => logger.openJobLogAsync(key, path),
        closeJobLog: (key) => logger.closeJobLog(key),
        getJobLogPath: (name, ts) =>
          `${getJobLogsDir()}/${name.replace(/[^a-zA-Z0-9_-]/g, "_")}-${ts}.log`,
      });
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
  brainInterface.initialize(io);

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
