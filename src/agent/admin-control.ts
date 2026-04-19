import fs from "node:fs/promises";

import { LoggerService } from "../services/logger.service.js";
import { ToolHotReloadService } from "../services/tool-hot-reload.service.js";
import { getSessionFilePath } from "../utils/paths.js";

export interface ChatSessionState {
  paused: boolean;
  resumeResolve?: (() => void) | null;
  abortController: AbortController | null;
  readonly steeringQueue: string[];
  isSteeringAbort: boolean;
}

export class AdminControl {
  private _sessions: Map<string, ChatSessionState>;
  private _logger: LoggerService;

  constructor(sessions: Map<string, ChatSessionState>, logger: LoggerService) {
    this._sessions = sessions;
    this._logger = logger;
  }

  pauseChat(chatId: string): boolean {
    const session: ChatSessionState | undefined = this._sessions.get(chatId);

    if (!session || session.paused) {
      return false;
    }

    session.paused = true;
    this._logger.info("Chat paused.", { chatId });
    return true;
  }

  resumeChat(chatId: string): boolean {
    const session: ChatSessionState | undefined = this._sessions.get(chatId);

    if (!session || !session.paused) {
      return false;
    }

    session.paused = false;

    if (session.resumeResolve) {
      session.resumeResolve();
      session.resumeResolve = null;
    }

    this._logger.info("Chat resumed.", { chatId });
    return true;
  }

  stopChat(chatId: string): boolean {
    const session: ChatSessionState | undefined = this._sessions.get(chatId);

    if (!session || !session.abortController) {
      return false;
    }

    session.isSteeringAbort = false;
    session.abortController.abort();
    this._logger.info("Chat stopped.", { chatId });
    return true;
  }

  steerChat(chatId: string, message: string): boolean {
    const session: ChatSessionState | undefined = this._sessions.get(chatId);

    if (!session) {
      this._logger.warn("Cannot steer: session not found", { chatId });
      return false;
    }

    session.steeringQueue.push(message);
    this._logger.info("Steering message queued", { chatId, queueLength: session.steeringQueue.length });

    if (session.abortController && !session.abortController.signal.aborted) {
      session.isSteeringAbort = true;
      session.abortController.abort();
      this._logger.info("Aborted current LLM call for steering", { chatId });
    }

    return true;
  }

  clearChatHistory(chatId: string): void {
    this._sessions.delete(chatId);
    ToolHotReloadService.getInstance().unregisterRebuildCallback(chatId);
    fs.unlink(getSessionFilePath(chatId)).catch(() => {
      // File may not exist, ignore
    });
    this._logger.info("Chat history cleared.", { chatId });
  }

  clearAllChatHistory(): void {
    this._sessions.clear();
    this._logger.info("All chat history cleared.");
  }
}

export function createAdminControl(sessions: Map<string, ChatSessionState>, logger: LoggerService): AdminControl {
  return new AdminControl(sessions, logger);
}
