import { tool } from "ai";
import { listSkillsToolInputSchema, type listSkillsToolOutputSchema } from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { sanitizeSetupError } from "../helpers/skill-state.js";
import { MAX_SETUP_ERROR_PREVIEW_LENGTH } from "../shared/constants.js";
import type { z } from "zod";

export type IListSkillsResult = z.infer<typeof listSkillsToolOutputSchema>;

export const listSkillsTool = tool({
  description:
    "List the current eligible skills and their descriptions. Also reports model-visible skills blocked by setup, including retry state and manual steps. Use an exact returned name with load_skill to load instructions.",
  inputSchema: listSkillsToolInputSchema,
  execute: async (): Promise<IListSkillsResult> => {
    const loader: SkillLoaderService = SkillLoaderService.getInstance();
    await loader.refreshAsync();
    return {
      skills: loader.getAvailableSkills().map((skill) => ({
        name: skill.name,
        description: skill.frontmatter.description,
      })),
      unavailableSkills: loader.getAllSkills()
        .filter((skill) => !skill.frontmatter.disableModelInvocation && skill.state.state !== "ready")
        .map((skill) => ({
          name: skill.name,
          description: skill.frontmatter.description,
          state: skill.state.state,
          missingDeps: skill.state.missingDeps,
          lastError: skill.state.lastError ? sanitizeSetupError(skill.state.lastError).slice(0, MAX_SETUP_ERROR_PREVIEW_LENGTH) : null,
          nextSetupAttemptAt: skill.state.nextSetupAttemptAt,
          manualStepsRequired: skill.state.manualStepsRequired.map((step) => sanitizeSetupError(step)),
        })),
    };
  },
});
