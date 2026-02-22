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
import { CronAgent } from "./agent/cron-agent.js";
import { TelegramBot } from "./telegram/bot.js";
import { BrainInterfaceService } from "./brain-interface/service.js";
import { StatusService } from "./services/status.service.js";
import type { IConfig, IScheduledTask } from "./shared/types/index.js";

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

  // 2.5. Clean up orphaned jobs in "creating" status (from interrupted job creation)
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

  // 8. Initialize Telegram bot (if configured)
  let telegramBot: TelegramBot | null = null;

  if (config.telegram) {
    telegramBot = TelegramBot.getInstance();

    await telegramBot.initializeAsync(config.telegram.botToken);

    logger.info("Telegram bot initialized.");
  } else {
    logger.warn("Telegram not configured. Bot will not start.");
  }

  // 9. Initialize scheduler (if enabled)
  const schedulerService: SchedulerService = SchedulerService.getInstance();

  if (config.scheduler.enabled) {
    const cronAgent: CronAgent = CronAgent.getInstance();

    schedulerService.setTaskExecutor(async (task: IScheduledTask): Promise<void> => {
      // Create a message sender for cron tasks.
      // If a notification chat ID is configured, send messages there.
      // Otherwise, log the messages instead of trying to send to a non-existent chat.
      const notificationChatId: string | null = config.scheduler.notificationChatId;

      let sender: (message: string) => Promise<string | null>;

      if (notificationChatId && config.telegram) {
        sender = messagingService.createSenderForChat("telegram", notificationChatId);
      } else {
        const logger: LoggerService = LoggerService.getInstance();
        sender = async (message: string): Promise<string | null> => {
          logger.info("Cron task message (no notification chat configured)", { taskId: task.taskId, message });
          return null;
        };
      }

      await cronAgent.executeTaskAsync(task, sender);
    });

    await schedulerService.startAsync();

    logger.info("Scheduler started.");
  } else {
    logger.info("Scheduler disabled in config.");
  }

  // 10. Start Telegram bot
  if (telegramBot) {
    await telegramBot.startAsync();
  }

  // 11. Initialize BrainInterface (WebSocket server for debug UI)
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

  // 12. Graceful shutdown
  const shutdownAsync = async (): Promise<void> => {
    logger.info("Shutdown signal received. Stopping BetterClaw...");

    if (telegramBot) {
      await telegramBot.stopAsync();
    }

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
