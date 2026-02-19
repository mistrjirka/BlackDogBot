import fs from "node:fs/promises";

import { tool } from "ai";

import { editFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { resolveFilePath } from "../utils/file-tools-helper.js";

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
    "The default location is the workspace directory (~/.betterclaw/workspace/). " +
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

    try {
      const resolved: string = resolveFilePath(filePath);

      const content: string = await fs.readFile(resolved, "utf-8");

      if (!content.includes(oldString)) {
        return { success: false, replacements: 0, message: `The string to find was not found in the file "${filePath}".` };
      }

      let updatedContent: string;
      let replacements: number;

      if (replaceAll) {
        // Count occurrences
        replacements = content.split(oldString).length - 1;
        updatedContent = content.replaceAll(oldString, newString);
      } else {
        replacements = 1;
        updatedContent = content.replace(oldString, newString);
      }

      await fs.writeFile(resolved, updatedContent, "utf-8");

      logger.debug("File edited successfully", { path: resolved, replacements });

      return { success: true, replacements, message: `Replaced ${replacements} occurrence(s) successfully.` };
    } catch (error: unknown) {
      const errorMessage: string = (error as Error).message;

      logger.debug("File edit failed", { path: filePath, error: errorMessage });

      return { success: false, replacements: undefined, message: errorMessage };
    }
  },
});

//#endregion Tool
