import fs from "node:fs/promises";

import { LoggerService } from "./logger.service.js";
import { JobStorageService } from "./job-storage.service.js";
import { SchedulerService } from "./scheduler.service.js";
import { PromptService } from "./prompt.service.js";
import { MainAgent } from "../agent/main-agent.js";
import { getRssStateDir, getCronDir, getSkillsDir, getLogsDir, getWorkspaceDir, getDatabasesDir, getKnowledgeDir, getTelegramChatsFilePath, ensureDirectoryExistsAsync } from "../utils/paths.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

export interface IFactoryResetResult {
  success: boolean;
  errors: string[];
}

//#endregion Interfaces

//#region Public functions

export async function factoryResetAsync(): Promise<IFactoryResetResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const errors: string[] = [];

  logger.info("Factory reset started");

  // 1. Delete all jobs
  await _safeStepAsync("Delete all jobs", errors, async (): Promise<void> => {
    const jobStorage: JobStorageService = JobStorageService.getInstance();
    await jobStorage.deleteAllJobsAsync();
  });

  // 2. Wipe knowledge / LanceDB
  await _safeStepAsync("Wipe knowledge store", errors, async (): Promise<void> => {
    await _wipeDirAsync(getKnowledgeDir());
  });

  // 3. Remove all scheduled tasks
  await _safeStepAsync("Remove all scheduled tasks", errors, async (): Promise<void> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();
    await scheduler.removeAllTasksAsync();
  });

  // 3b. Wipe cron directory directly (safety net for unparseable files)
  await _safeStepAsync("Wipe cron directory", errors, async (): Promise<void> => {
    await _wipeDirAsync(getCronDir());
  });

  // 3c. Delete known Telegram chats (authorized users)
  await _safeStepAsync("Delete known Telegram chats", errors, async (): Promise<void> => {
    const filePath: string = getTelegramChatsFilePath();
    await fs.rm(filePath, { recursive: true, force: true });
  });

  // 4. Clear RSS state
  await _safeStepAsync("Clear RSS state", errors, async (): Promise<void> => {
    await _wipeDirAsync(getRssStateDir());
  });

  // 5. Clear skill state files (state.json inside each skill dir)
  await _safeStepAsync("Clear skill state", errors, async (): Promise<void> => {
    await _deleteFilesInDirAsync(getSkillsDir(), "state.json");
  });

  // 6. Reset all prompts to factory defaults
  await _safeStepAsync("Reset prompts", errors, async (): Promise<void> => {
    const promptService: PromptService = PromptService.getInstance();
    await promptService.resetAllPromptsAsync();
    promptService.clearCache();
  });

  // 7. Clear all chat history
  await _safeStepAsync("Clear chat history", errors, async (): Promise<void> => {
    const mainAgent: MainAgent = MainAgent.getInstance();
    mainAgent.clearAllChatHistory();
  });

  // 8. Wipe workspace
  await _safeStepAsync("Wipe workspace", errors, async (): Promise<void> => {
    await _wipeDirAsync(getWorkspaceDir());
  });

  // 9. Wipe logs
  await _safeStepAsync("Wipe logs", errors, async (): Promise<void> => {
    await _wipeDirAsync(getLogsDir());
  });

  // 10. Wipe user databases
  await _safeStepAsync("Wipe databases", errors, async (): Promise<void> => {
    await _wipeDirAsync(getDatabasesDir());
  });

  const success: boolean = errors.length === 0;

  if (success) {
    logger.info("Factory reset completed successfully");
  } else {
    logger.warn("Factory reset completed with errors", { errors });
  }

  return { success, errors };
}

//#endregion Public functions

//#region Private functions

async function _safeStepAsync(
  stepName: string,
  errors: string[],
  action: () => Promise<void>,
): Promise<void> {
  const logger: LoggerService = LoggerService.getInstance();

  try {
    await action();
    logger.info(`Factory reset step completed: ${stepName}`);
  } catch (error: unknown) {
    const message: string = extractErrorMessage(error);
    errors.push(`${stepName}: ${message}`);
    logger.error(`Factory reset step failed: ${stepName}`, { error: message });
  }
}

async function _wipeDirAsync(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
  await ensureDirectoryExistsAsync(dirPath);
}

async function _deleteFilesInDirAsync(parentDir: string, fileName: string): Promise<void> {
  let entries: string[];

  try {
    entries = await fs.readdir(parentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath: string = `${parentDir}/${entry}/${fileName}`;

    try {
      await fs.unlink(filePath);
    } catch {
      // File doesn't exist in this subdirectory, skip
    }
  }
}

//#endregion Private functions
