import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import type { z } from "zod";
import {
  getSkillFileToolInputSchema,
  type getSkillFileToolOutputSchema,
} from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { MAX_SKILL_FILE_BYTES, readFileBoundedAsync } from "../utils/bounded-file.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { sanitizeSetupError } from "../helpers/skill-state.js";

export type IGetSkillFileResult = z.infer<typeof getSkillFileToolOutputSchema>;


export const getSkillFileTool = tool({
  description:
    "Read a file from a ready, model-visible skill's directory. Unavailable skills return exists:false.",
  inputSchema: getSkillFileToolInputSchema,
  execute: async ({
    skillName,
    filePath,
  }: {
    skillName: string;
    filePath: string;
  }): Promise<IGetSkillFileResult> => {
    const logger: LoggerService = LoggerService.getInstance();
    const loader: SkillLoaderService = SkillLoaderService.getInstance();
    const displaySkillName: string = sanitizeSetupError(skillName);
    const displayFilePath: string = sanitizeSetupError(filePath);
    try {
      await loader.refreshAsync();
      const skill = loader.getAvailableSkill(skillName);
      const skillDir: string | undefined = skill?.directory;
      if (!skillDir) {
        return { content: "", exists: false };
      }
      const resolvedSkillDir: string = await fs.realpath(skillDir);
      if (resolvedSkillDir !== skillDir) {
        logger.warn("Skill directory changed after catalog refresh", {
          skillName: displaySkillName,
          expectedDir: sanitizeSetupError(skillDir),
          resolvedDir: sanitizeSetupError(resolvedSkillDir),
        });
        return { content: "", exists: false };
      }
      const fullPath: string = path.resolve(resolvedSkillDir, filePath);

      // Path traversal protection: resolved path must be within the skill directory
      if (
        !fullPath.startsWith(resolvedSkillDir + path.sep) &&
        fullPath !== resolvedSkillDir
      ) {
        logger.warn("Path traversal attempt blocked in get_skill_file", {
          skillName: displaySkillName,
          filePath: displayFilePath,
          fullPath: sanitizeSetupError(fullPath),
        });
        return { content: "", exists: false };
      }

      const realPath: string = await fs.realpath(fullPath);
      if (!realPath.startsWith(resolvedSkillDir + path.sep)) {
        logger.warn("Symlink escape blocked in get_skill_file", {
          skillName: displaySkillName,
          filePath: displayFilePath,
          realPath: sanitizeSetupError(realPath),
        });
        return { content: "", exists: false };
      }
      const content: string = await readFileBoundedAsync(realPath, MAX_SKILL_FILE_BYTES);

      logger.debug(`Read skill file "${displayFilePath}" from skill "${displaySkillName}"`);

      return { content, exists: true };
    } catch (err: unknown) {
      const errorMessage: string = sanitizeSetupError(extractErrorMessage(err));

      logger.debug(
        `Skill file not found: "${displayFilePath}" in skill "${displaySkillName}" — ${errorMessage}`,
      );

      return { content: "", exists: false };
    }
  },
});
