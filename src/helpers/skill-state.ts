import fs from "node:fs/promises";

import { ISkillStateInfo } from "../shared/types/index.js";
import { skillStateInfoSchema } from "../shared/schemas/index.js";
import { LoggerService } from "../services/logger.service.js";
import { getSkillStatePath, getSkillDir, ensureDirectoryExistsAsync } from "../utils/paths.js";

//#region Public Functions

export async function getSkillStateAsync(skillName: string): Promise<ISkillStateInfo> {
  const filePath: string = getSkillStatePath(skillName);
  const logger: LoggerService = LoggerService.getInstance();

  try {
    const content: string = await fs.readFile(filePath, "utf-8");
    const raw: unknown = JSON.parse(content);
    const parsed: ISkillStateInfo = skillStateInfoSchema.parse(raw);

    return parsed;
  } catch {
    logger.debug(`No existing state found for skill "${skillName}", returning default state`);

    return {
      state: "never-touched",
      lastError: null,
      setupAt: null,
      lastCheckedAt: null,
      missingDeps: null,
      manualStepsRequired: [],
      attemptedInstalls: [],
    };
  }
}

export async function saveSkillStateAsync(skillName: string, state: ISkillStateInfo): Promise<void> {
  const skillDir: string = getSkillDir(skillName);
  const logger: LoggerService = LoggerService.getInstance();

  await ensureDirectoryExistsAsync(skillDir);

  const filePath: string = getSkillStatePath(skillName);
  const content: string = JSON.stringify(state, null, 2);

  await fs.writeFile(filePath, content, "utf-8");

  logger.debug(`Saved state for skill "${skillName}"`, { state: state.state });
}

export async function markSkillSetupCompleteAsync(skillName: string): Promise<void> {
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const state: ISkillStateInfo = {
    state: "ready",
    lastError: null,
    setupAt: now,
    lastCheckedAt: now,
    missingDeps: null,
    manualStepsRequired: [],
    attemptedInstalls: [],
  };

  await saveSkillStateAsync(skillName, state);

  logger.info(`Skill "${skillName}" marked as ready`);
}

export async function markSkillSetupErrorAsync(skillName: string, error: string): Promise<void> {
  const currentState: ISkillStateInfo = await getSkillStateAsync(skillName);
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const state: ISkillStateInfo = {
    state: "setup-failed",
    lastError: error,
    setupAt: null,
    lastCheckedAt: now,
    missingDeps: currentState.missingDeps,
    manualStepsRequired: currentState.manualStepsRequired,
    attemptedInstalls: currentState.attemptedInstalls,
  };

  await saveSkillStateAsync(skillName, state);

  logger.warn(`Skill "${skillName}" setup failed: ${error}`);
}

export async function markSkillSetupInProgressAsync(skillName: string): Promise<void> {
  const currentState: ISkillStateInfo = await getSkillStateAsync(skillName);
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const state: ISkillStateInfo = {
    state: "setup-in-progress",
    lastError: null,
    setupAt: null,
    lastCheckedAt: now,
    missingDeps: currentState.missingDeps,
    manualStepsRequired: currentState.manualStepsRequired,
    attemptedInstalls: currentState.attemptedInstalls,
  };

  await saveSkillStateAsync(skillName, state);

  logger.debug(`Skill "${skillName}" setup in progress`);
}

export async function markSkillNeedsSetupAsync(
  skillName: string,
  missingDeps: ISkillStateInfo["missingDeps"],
  manualSteps: string[],
): Promise<void> {
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const state: ISkillStateInfo = {
    state: "needs-setup",
    lastError: null,
    setupAt: null,
    lastCheckedAt: now,
    missingDeps,
    manualStepsRequired: manualSteps,
    attemptedInstalls: [],
  };

  await saveSkillStateAsync(skillName, state);

  logger.info(`Skill "${skillName}" needs setup`);
}

export async function addSkillAttemptedInstallAsync(skillName: string, stepId: string): Promise<void> {
  const currentState: ISkillStateInfo = await getSkillStateAsync(skillName);
  const attemptedInstalls: string[] = [...(currentState.attemptedInstalls || []), stepId];
  const state: ISkillStateInfo = {
    ...currentState,
    attemptedInstalls,
    lastCheckedAt: new Date().toISOString(),
  };

  await saveSkillStateAsync(skillName, state);
}

//#endregion Public Functions
