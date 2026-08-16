import { tool } from "ai";
import type { z } from "zod";
import {
  loadSkillToolInputSchema,
  type loadSkillToolOutputSchema,
} from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { sanitizeSetupError } from "../helpers/skill-state.js";
import { MAX_SETUP_ERROR_PREVIEW_LENGTH } from "../shared/constants.js";

export type ILoadSkillResult = z.infer<typeof loadSkillToolOutputSchema>;

export const loadSkillTool = tool({
  description:
    "Load a skill's instructions into the current tool loop using an exact name from list_skills. This does not create or invoke another agent.",
  inputSchema: loadSkillToolInputSchema,
  execute: async ({
    skillName,
  }: {
    skillName: string;
  }): Promise<ILoadSkillResult> => {
    const loader: SkillLoaderService = SkillLoaderService.getInstance();
    let instructions: string | undefined;
    try {
      await loader.refreshAsync();
      instructions = await loader.loadSkillInstructionsAsync(skillName);
    } catch (error: unknown) {
      return { success: false, skillName, instructions: "", error: sanitizeSetupError(extractErrorMessage(error)) };
    }
    if (instructions === undefined) {
      const skill = loader.getSkill(skillName);
      const details = skill
        ? [
          skill.frontmatter.disableModelInvocation ? "disabled" : null,
          `state=${skill.state.state}`,
          skill.state.lastError ? `lastError=${sanitizeSetupError(skill.state.lastError).slice(0, MAX_SETUP_ERROR_PREVIEW_LENGTH)}` : null,
          skill.state.nextSetupAttemptAt ? `retryAt=${skill.state.nextSetupAttemptAt}` : null,
        ].filter((detail): detail is string => detail !== null).join(", ")
        : "unknown, disabled, or not ready";
      return {
        success: false,
        skillName,
        instructions: "",
        error: `Skill "${skillName}" is unavailable (${details}).`,
      };
    }
    return { success: true, skillName, instructions, error: null };
  },
});
