import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import { appendFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { resolveFilePath } from "../utils/file-tools-helper.js";
import { ensureDirectoryExistsAsync } from "../utils/paths.js";

//#region Interfaces

interface IAppendFileResult {
  success: boolean;
  message: string;
}

//#endregion Interfaces

//#region Tool

export const appendFileTool = tool({
  description:
    "Append content to the end of a file. Creates the file if it does not exist. " +
    "Does NOT require reading the file first. " +
    "The default location is the workspace directory (~/.betterclaw/workspace/). " +
    "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
    "Only specify an absolute path when accessing files outside the workspace.",
  inputSchema: appendFileToolInputSchema,
  execute: async ({ filePath, content }: { filePath: string; content: string }): Promise<IAppendFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const resolved: string = resolveFilePath(filePath);

      await ensureDirectoryExistsAsync(path.dirname(resolved));

      await fs.appendFile(resolved, content, "utf-8");

      logger.debug("Content appended to file", { path: resolved, appendedSize: content.length });

      return { success: true, message: `Content appended successfully (${content.length} characters).` };
    } catch (error: unknown) {
      const errorMessage: string = (error as Error).message;

      logger.debug("File append failed", { path: filePath, error: errorMessage });

      return { success: false, message: errorMessage };
    }
  },
});

//#endregion Tool
