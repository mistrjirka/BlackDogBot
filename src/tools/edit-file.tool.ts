import fs from "node:fs/promises";

import { tool } from "ai";

import { editFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { runFileOperationAsync } from "../utils/file-operation-helper.js";

//#region Interfaces

interface IEditFileResult {
  success: boolean;
  replacements: number | undefined;
  message: string;
}

//#endregion Interfaces

//#region Tool

export const editFileTool = tool({
  description:
    "Find and replace text in a file. Does NOT require reading the file first. " +
    "Replaces the first occurrence of oldString by default, or all occurrences if replaceAll is true. " +
    "The default location is the workspace directory (~/.blackdogbot/workspace/). " +
    "For most tasks, just provide a filename (e.g. 'notes.txt') without a full path. " +
    "Only specify an absolute path when accessing files outside the workspace.",
  inputSchema: editFileToolInputSchema,
  execute: async ({
    filePath,
    oldString,
    newString,
    replaceAll,
  }: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
  }): Promise<IEditFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    const operationResult = await runFileOperationAsync<IEditFileResult>({
      logger,
      filePath,
      onErrorLogMessage: "File edit failed",
      runAsync: async (resolvedPath: string): Promise<IEditFileResult> => {
        const content: string = await fs.readFile(resolvedPath, "utf-8");

        if (!content.includes(oldString)) {
          return {
            success: false,
            replacements: 0,
            message: `The string to find was not found in the file "${filePath}".`,
          };
        }

        let updatedContent: string;
        let replacements: number;

        if (replaceAll) {
          replacements = content.split(oldString).length - 1;
          updatedContent = content.replaceAll(oldString, newString);
        } else {
          replacements = 1;
          updatedContent = content.replace(oldString, newString);
        }

        await fs.writeFile(resolvedPath, updatedContent, "utf-8");

        return { success: true, replacements, message: `Replaced ${replacements} occurrence(s) successfully.` };
      },
    });

    if (!operationResult.success) {
      return { success: false, replacements: undefined, message: operationResult.errorMessage };
    }

    if (!operationResult.value.success) {
      return operationResult.value;
    }

    logger.debug("File edited successfully", {
      path: operationResult.resolvedPath,
      replacements: operationResult.value.replacements,
    });

    return operationResult.value;
  },
});

//#endregion Tool
