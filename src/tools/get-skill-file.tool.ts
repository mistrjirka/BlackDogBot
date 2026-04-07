import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import { getSkillFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { getSkillDir } from "../utils/paths.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IGetSkillFileResult {
  content: string;
  exists: boolean;
}

//#endregion Interfaces

export const getSkillFileTool = tool({
  description: "Read a file from a skill's directory. Returns the file content if it exists.",
  inputSchema: getSkillFileToolInputSchema,
  execute: async ({ skillName, filePath }: { skillName: string; filePath: string }): Promise<IGetSkillFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const fullPath: string = path.join(getSkillDir(skillName), filePath);
      const content: string = await fs.readFile(fullPath, "utf-8");

      logger.debug(`Read skill file "${filePath}" from skill "${skillName}"`);

      return { content, exists: true };
    } catch (err: unknown) {
      const errorMessage: string = extractErrorMessage(err);

      logger.debug(`Skill file not found: "${filePath}" in skill "${skillName}" — ${errorMessage}`);

      return { content: "", exists: false };
    }
  },
});
