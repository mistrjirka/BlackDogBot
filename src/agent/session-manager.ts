import fs from "node:fs/promises";
import { type ModelMessage } from "ai";
import { ensureDirectoryExistsAsync, getSessionsDir, getSessionFilePath } from "../utils/paths.js";
import { LoggerService } from "../services/logger.service.js";

export interface IPersistedSession {
  messages: ModelMessage[];
  lastActivityAt: number;
}

interface IBufferMarker {
  __type: "Buffer";
  __data: string;
}

const _BufferMarkerType: IBufferMarker["__type"] = "Buffer";

/**
 * Persists a chat session to disk.
 * Serializes session messages and metadata to JSON, handling Buffer objects by encoding as base64.
 * @param sessions - Map of chat sessions indexed by chat ID
 * @param chatId - The chat session identifier to save
 * @returns Promise that resolves when the session has been written to disk
 */
export async function saveSessionAsync<ParsedSession extends IPersistedSession>(sessions: Map<string, ParsedSession>, chatId: string): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) {
    return;
  }

  const persistable: IPersistedSession = {
    messages: session.messages,
    lastActivityAt: session.lastActivityAt as number,
  };

  await ensureDirectoryExistsAsync(getSessionsDir());
  const filePath: string = getSessionFilePath(chatId);
  await fs.writeFile(filePath, JSON.stringify(persistable, _sessionStringifyReplacer, 2), "utf-8");
}

/**
 * Loads a chat session from disk.
 * Parses JSON and restores Buffer objects from base64 encoding.
 * @param chatId - The chat session identifier to load
 * @returns Promise resolving to the session data or null if not found
 */
export async function loadSessionAsync(chatId: string): Promise<IPersistedSession | null> {
  const filePath: string = getSessionFilePath(chatId);
  const logger: LoggerService = LoggerService.getInstance();

  try {
    const content: string = await fs.readFile(filePath, "utf-8");
    const parsed: IPersistedSession = JSON.parse(content, _sessionParseReviver) as IPersistedSession;

    if (!Array.isArray(parsed.messages)) {
      return null;
    }

    parsed.messages = _normalizeLoadedSessionMessages(parsed.messages);

    return parsed;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    const message: string = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to load session from disk, starting fresh.", { chatId, error: message });
    return null;
  }
}

function _sessionStringifyReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return {
      __type: _BufferMarkerType,
      __data: value.toString("base64"),
    } satisfies IBufferMarker;
  }

  if (value instanceof Uint8Array) {
    return {
      __type: _BufferMarkerType,
      __data: Buffer.from(value).toString("base64"),
    } satisfies IBufferMarker;
  }

  return value;
}

function _sessionParseReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__type" in value &&
    (value as { __type?: unknown }).__type === _BufferMarkerType &&
    "__data" in value &&
    typeof (value as { __data?: unknown }).__data === "string"
  ) {
    try {
      return Buffer.from((value as { __data: string }).__data, "base64");
    } catch {
      return value;
    }
  }

  // Backward-compatible restore for Node's default Buffer JSON shape:
  // { type: "Buffer", data: number[] }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: unknown }).type === "Buffer" &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    try {
      return Buffer.from((value as { data: number[] }).data);
    } catch {
      return value;
    }
  }

  return value;
}

function _normalizeLoadedSessionMessages(messages: ModelMessage[]): ModelMessage[] {
  const normalized: ModelMessage[] = [];

  for (const message of messages) {
    const clonedMessage: ModelMessage = { ...message };

    if (Array.isArray(clonedMessage.content)) {
      const normalizedParts: unknown[] = [];

      for (const part of clonedMessage.content as unknown[]) {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type?: unknown }).type === "image" &&
          "image" in part
        ) {
          const imagePart: Record<string, unknown> = { ...(part as Record<string, unknown>) };
          const imageValue: unknown = imagePart.image;

          if (Buffer.isBuffer(imageValue) || imageValue instanceof Uint8Array || typeof imageValue === "string") {
            normalizedParts.push(imagePart);
            continue;
          }

          if (
            imageValue &&
            typeof imageValue === "object" &&
            "type" in imageValue &&
            (imageValue as { type?: unknown }).type === "Buffer" &&
            "data" in imageValue &&
            Array.isArray((imageValue as { data?: unknown }).data)
          ) {
            try {
              imagePart.image = Buffer.from((imageValue as { data: number[] }).data);
              normalizedParts.push(imagePart);
              continue;
            } catch {
              continue;
            }
          }

          continue;
        }

        normalizedParts.push(part);
      }

      clonedMessage.content = normalizedParts as typeof clonedMessage.content;
    }

    normalized.push(clonedMessage);
  }

  return normalized;
}
