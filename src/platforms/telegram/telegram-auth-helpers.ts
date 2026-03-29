import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

import type { LoggerService } from "../../services/logger.service.js";
import { extractErrorMessage } from "../../utils/error.js";
import type { ITelegramConfig } from "./types.js";

//#region Public Functions

export async function loadKnownChatIdsAsync(
  chatIdsFilePath: string,
  logger: LoggerService,
): Promise<Set<string>> {
  try {
    if (!existsSync(chatIdsFilePath)) {
      return new Set<string>();
    }

    const data: string = await readFile(chatIdsFilePath, "utf-8");
    const chatIds: string[] = JSON.parse(data) as string[];
    logger.info(`Loaded ${chatIds.length} known Telegram chat IDs`);

    return new Set<string>(chatIds);
  } catch (error: unknown) {
    logger.warn("Failed to load known Telegram chat IDs", {
      error: extractErrorMessage(error),
    });
    return new Set<string>();
  }
}

export async function saveKnownChatIdsAsync(
  chatIdsFilePath: string,
  knownChatIds: Set<string>,
  logger: LoggerService,
): Promise<void> {
  try {
    const dir: string = dirname(chatIdsFilePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const chatIds: string[] = Array.from(knownChatIds);
    await writeFile(chatIdsFilePath, JSON.stringify(chatIds, null, 2));
  } catch (error: unknown) {
    logger.warn("Failed to save known Telegram chat IDs", {
      error: extractErrorMessage(error),
    });
  }
}

export async function isTelegramChatAuthorizedAsync(
  chatId: string,
  config: ITelegramConfig | null,
  knownChatIds: Set<string>,
  saveKnownChatIdsFnAsync: () => Promise<void>,
  logger: LoggerService,
): Promise<boolean> {
  if (!config) {
    return false;
  }

  const allowedUsers: string[] | undefined = config.allowedUsers;
  if (allowedUsers && allowedUsers.length > 0) {
    return allowedUsers.includes(chatId);
  }

  if (knownChatIds.size === 0) {
    knownChatIds.add(chatId);
    await saveKnownChatIdsFnAsync();
    logger.info(`Registered first Telegram user: ${chatId}`);
    return true;
  }

  return knownChatIds.has(chatId);
}

//#endregion Public Functions
