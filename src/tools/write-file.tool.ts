import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import { writeFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { resolveFilePath, type IFileReadTracker } from "../utils/file-tools-helper.js";
import { ensureDirectoryExistsAsync } from "../utils/paths.js";

//#region Interfaces

interface IWriteFileResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Factory

export function createWriteFileTool(readTracker: IFileReadTracker) {
  return tool({
    description:
      "Write content to a file, completely replacing its contents. " +
      "IMPORTANT: You MUST read the file with read_file first before overwriting it. " +
      "If the file does not exist yet, you can write to it without reading first. " +
      "The default location is the workspace directory (~/.betterclaw/workspace/). " +
      "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
      "Only specify an absolute path when accessing files outside the workspace.",
    inputSchema: writeFileToolInputSchema,
    execute: async ({ filePath, content }: { filePath: string; content: string }): Promise<IWriteFileResult> => {
      const logger: LoggerService = LoggerService.getInstance();

      try {
        const resolved: string = resolveFilePath(filePath);

        await ensureDirectoryExistsAsync(path.dirname(resolved));

        // Check if file exists — if it does, enforce read-before-write guard
        let fileExists: boolean;

        try {
          await fs.access(resolved);
          fileExists = true;
        } catch {
          fileExists = false;
        }

        if (fileExists && !readTracker.hasBeenRead(resolved)) {
          return {
            success: false,
            message: `You must read the file "${filePath}" with read_file before overwriting it. This prevents accidental data loss.`,
          };
        }

        await fs.writeFile(resolved, content, "utf-8");

        // Mark as read after writing so subsequent writes don't re-trigger the guard
        readTracker.markRead(resolved);

        logger.debug("File written successfully", { path: resolved, size: content.length });

        return { success: true, message: `File written successfully (${content.length} characters).` };
      } catch (error: unknown) {
        const errorMessage: string = (error as Error).message;

        logger.debug("File write failed", { path: filePath, error: errorMessage });

        return { success: false, message: errorMessage };
      }
    },
  });
}

//#endregion Factory
