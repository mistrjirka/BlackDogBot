import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import { readFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { resolveFilePath, type IFileReadTracker } from "../utils/file-tools-helper.js";
import { ensureDirectoryExistsAsync } from "../utils/paths.js";

//#region Interfaces

interface IReadFileResult {
  success: boolean;
  content: string | undefined;
  message: string;
}

//#endregion Interfaces

//#region Factory

export function createReadFileTool(readTracker: IFileReadTracker) {
  return tool({
    description:
      "Read the contents of a file. The default location is the workspace directory (~/.betterclaw/workspace/). " +
      "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
      "Only specify an absolute path when accessing files outside the workspace.",
    inputSchema: readFileToolInputSchema,
    execute: async ({ filePath }: { filePath: string }): Promise<IReadFileResult> => {
      const logger: LoggerService = LoggerService.getInstance();

      try {
        const resolved: string = resolveFilePath(filePath);

        await ensureDirectoryExistsAsync(path.dirname(resolved));

        const content: string = await fs.readFile(resolved, "utf-8");

        readTracker.markRead(resolved);

        logger.debug("File read successfully", { path: resolved, size: content.length });

        return { success: true, content, message: `File read successfully (${content.length} characters).` };
      } catch (error: unknown) {
        const errorMessage: string = (error as Error).message;

        logger.debug("File read failed", { path: filePath, error: errorMessage });

        return { success: false, content: undefined, message: errorMessage };
      }
    },
  });
}

//#endregion Factory
