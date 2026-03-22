import fs from "node:fs/promises";

import { tool } from "ai";

import { appendFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { runFileOperationAsync } from "../utils/file-operation-helper.js";

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
    "The default location is the workspace directory (~/.blackdogbot/workspace/). " +
    "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
    "Only specify an absolute path when accessing files outside the workspace.",
  inputSchema: appendFileToolInputSchema,
  execute: async ({ filePath, content }: { filePath: string; content: string }): Promise<IAppendFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    const operationResult = await runFileOperationAsync<null>({
      logger,
      filePath,
      onErrorLogMessage: "File append failed",
      runAsync: async (resolvedPath: string): Promise<null> => {
        await fs.appendFile(resolvedPath, content, "utf-8");
        return null;
      },
    });

    if (!operationResult.success) {
      return { success: false, message: operationResult.errorMessage };
    }

    logger.debug("Content appended to file", {
      path: operationResult.resolvedPath,
      appendedSize: content.length,
    });

    return { success: true, message: `Content appended successfully (${content.length} characters).` };
  },
});

//#endregion Tool
