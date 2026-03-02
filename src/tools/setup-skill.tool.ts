import { tool } from "ai";

import { setupSkillToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import * as skillState from "../helpers/skill-state.js";
import * as skillInstaller from "../helpers/skill-installer.js";
import { LoggerService } from "../services/logger.service.js";
import type { ISkill, ISkillInstallStep } from "../shared/types/index.js";

interface ISetupSkillResult {
  success: boolean;
  state: string;
  installed: string[];
  manualStepsRequired: string[];
  error: string | null;
}

const DEFAULT_ALLOWED_KINDS = ["brew", "node", "go", "uv"];

export const createSetupSkillTool = (
  allowedKinds: string[] = DEFAULT_ALLOWED_KINDS,
  timeout: number = 300000,
) => {
  return tool({
    description:
      "Set up a skill by installing its dependencies. " +
      "Use this when a skill is in 'needs-setup' state. " +
      "Some install steps may require manual action (pacman, apt, download).",
    inputSchema: setupSkillToolInputSchema,
    execute: async ({ skillName }: { skillName: string }): Promise<ISetupSkillResult> => {
      const logger = LoggerService.getInstance();
      const skillLoader = SkillLoaderService.getInstance();

      const skill: ISkill | undefined = skillLoader.getSkill(skillName);

      if (!skill) {
        return {
          success: false,
          state: "not-found",
          installed: [],
          manualStepsRequired: [],
          error: `Skill "${skillName}" not found`,
        };
      }

      if (skill.state.state === "ready") {
        return {
          success: true,
          state: "ready",
          installed: [],
          manualStepsRequired: [],
          error: null,
        };
      }

      if (skill.state.state === "os-unsupported") {
        return {
          success: false,
          state: "os-unsupported",
          installed: [],
          manualStepsRequired: [],
          error: `Skill "${skillName}" is not supported on this operating system`,
        };
      }

      if (skill.state.state === "missing-deps") {
        const missing = skill.state.missingDeps;
        const manualInstructions = skillInstaller.getSkillMissingDepsInstructions({
          bins: missing?.bins || [],
          env: missing?.env || [],
          config: missing?.config || [],
        });

        return {
          success: false,
          state: "missing-deps",
          installed: [],
          manualStepsRequired: manualInstructions,
          error: `Skill "${skillName}" has missing dependencies with no install steps. Manual installation required.`,
        };
      }

      if (skill.state.state === "setup-in-progress") {
        return {
          success: false,
          state: "setup-in-progress",
          installed: [],
          manualStepsRequired: [],
          error: `Skill "${skillName}" setup is already in progress`,
        };
      }

      await skillState.markSkillSetupInProgressAsync(skillName);

      const installSteps: ISkillInstallStep[] = skill.frontmatter.metadata?.openclaw?.install || [];

      if (installSteps.length === 0) {
        await skillState.markSkillNeedsSetupAsync(
          skillName,
          skill.state.missingDeps,
          [],
        );

        return {
          success: false,
          state: "missing-deps",
          installed: [],
          manualStepsRequired: [],
          error: `Skill "${skillName}" has no install steps defined`,
        };
      }

      logger.info(`Starting setup for skill "${skillName}"`);

      const result = await skillInstaller.executeSkillInstallStepsAsync(installSteps, allowedKinds as any, timeout);

      if (result.success) {
        await skillState.markSkillSetupCompleteAsync(skillName);
        logger.info(`Skill "${skillName}" setup completed successfully`);

        return {
          success: true,
          state: "ready",
          installed: result.installed,
          manualStepsRequired: result.manualStepsRequired,
          error: null,
        };
      }

      if (result.manualStepsRequired.length > 0 && !result.error) {
        await skillState.markSkillNeedsSetupAsync(
          skillName,
          skill.state.missingDeps,
          result.manualStepsRequired,
        );

        return {
          success: false,
          state: "needs-setup",
          installed: result.installed,
          manualStepsRequired: result.manualStepsRequired,
          error: "Manual installation steps required",
        };
      }

      await skillState.markSkillSetupErrorAsync(skillName, result.error || "Unknown error");
      logger.error(`Skill "${skillName}" setup failed: ${result.error}`);

      return {
        success: false,
        state: "setup-failed",
        installed: result.installed,
        manualStepsRequired: result.manualStepsRequired,
        error: result.error,
      };
    },
  });
};
