import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import type { ISkill, ISkillMissingDeps, ISkillStateInfo, SkillState } from "../shared/types/index.js";
import { skillStateInfoSchema } from "../shared/schemas/index.js";
import { LoggerService } from "../services/logger.service.js";
import { getSkillStatePath, ensureDirectoryExistsAsync } from "../utils/paths.js";
import { MAX_SKILL_FILE_BYTES, readFileBoundedAsync } from "../utils/bounded-file.js";
import { MAX_AUTO_SETUP_ATTEMPTS, MAX_SETUP_ERROR_LENGTH } from "../shared/constants.js";
import { hasMissingInstallDependencies } from "./dependency-checker.js";

//#region Public Functions

export async function getSkillStateAsync(skillName: string, stateScope: string | null = null): Promise<ISkillStateInfo> {
  const filePath: string = getSkillStatePath(skillName, stateScope);
  const logger: LoggerService = LoggerService.getInstance();

  try {
    const content: string = await readFileBoundedAsync(filePath, MAX_SKILL_FILE_BYTES);
    const raw: unknown = JSON.parse(content);
    const parsed: ISkillStateInfo = skillStateInfoSchema.parse(raw);

    return parsed;
  } catch (error: unknown) {
    // ENOENT is expected — skill hasn't been used yet
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug(`No existing state found for skill "${sanitizeSetupError(skillName)}", returning default state`);
    } else {
      // File exists but is corrupted or unreadable — log warning
      const message: string = error instanceof Error ? error.message : String(error);
      logger.warn(`Corrupted state file for skill "${sanitizeSetupError(skillName)}", returning default state`, {
        error: sanitizeSetupError(message),
      });
    }

    return skillStateInfoSchema.parse({});
  }
}

export async function saveSkillStateAsync(skillName: string, state: ISkillStateInfo, stateScope: string | null = null): Promise<void> {
  const logger: LoggerService = LoggerService.getInstance();

  const filePath: string = getSkillStatePath(skillName, stateScope);

  await ensureDirectoryExistsAsync(path.dirname(filePath));
  await assertRegularStateFileAsync(filePath);
  const content: string = JSON.stringify(state, null, 2);

  await fs.writeFile(filePath, content, "utf-8");

  logger.debug(`Saved state for skill "${sanitizeSetupError(skillName)}"`, { state: state.state });
}

export { MAX_AUTO_SETUP_ATTEMPTS, MAX_SETUP_ERROR_LENGTH } from "../shared/constants.js";

export function sanitizeSetupError(error: string): string {
  return error.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").slice(0, MAX_SETUP_ERROR_LENGTH);
}

async function assertRegularStateFileAsync(filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error("Skill state path is not a regular file or has multiple links");
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function getSetupBackoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 2 ** Math.max(0, attempt - 1) * 60_000);
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForFingerprint(item));
  }
  if (value !== null && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue).sort()) {
      canonical[key] = canonicalizeForFingerprint(objectValue[key]);
    }
    return canonical;
  }
  return value;
}

function _buildState(
  state: SkillState,
  lastError: string | null,
  setupAt: string | null,
  lastCheckedAt: string,
  missingDeps: ISkillMissingDeps | null,
  manualStepsRequired: string[],
  attemptedInstalls: string[],
  setupFingerprint: string | null,
  setupAttempts: number,
  nextSetupAttemptAt: string | null,
): ISkillStateInfo {
  return {
    state,
    lastError,
    setupAt,
    lastCheckedAt,
    missingDeps,
    manualStepsRequired,
    attemptedInstalls,
    setupFingerprint,
    setupAttempts,
    nextSetupAttemptAt,
  };
}

export function getSkillSetupFingerprint(skill: ISkill): string {
  const openclaw = skill.frontmatter.metadata.openclaw;
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeForFingerprint(openclaw))).digest("hex");
}

export async function markSkillSetupCompleteAsync(skillName: string, fingerprint: string | null = null, stateScope: string | null = null): Promise<void> {
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const state: ISkillStateInfo = _buildState("ready", null, now, now, null, [], [], fingerprint, 0, null);

  await saveSkillStateAsync(skillName, state, stateScope);

  logger.info(`Skill "${sanitizeSetupError(skillName)}" marked as ready`);
}

export async function markSkillSetupErrorAsync(skillName: string, error: string, fingerprint: string | null = null, stateScope: string | null = null): Promise<void> {
  const currentState: ISkillStateInfo = await getSkillStateAsync(skillName, stateScope);
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const safeError: string = sanitizeSetupError(error);
  const fingerprintChanged: boolean = fingerprint !== null && fingerprint !== currentState.setupFingerprint;
  const setupAttempts: number = Math.min(
    MAX_AUTO_SETUP_ATTEMPTS,
    fingerprintChanged ? 1 : Math.max(1, currentState.setupAttempts),
  );
  const state: ISkillStateInfo = _buildState(
    "setup-failed", safeError, null, now, currentState.missingDeps, currentState.manualStepsRequired,
    currentState.attemptedInstalls, fingerprint ?? currentState.setupFingerprint, setupAttempts,
    setupAttempts >= MAX_AUTO_SETUP_ATTEMPTS ? null : new Date(Date.now() + getSetupBackoffMs(setupAttempts)).toISOString(),
  );

  await saveSkillStateAsync(skillName, state, stateScope);

  logger.warn(`Skill "${sanitizeSetupError(skillName)}" setup failed: ${safeError}`);
}

export async function markSkillSetupInProgressAsync(skillName: string, fingerprint: string | null = null, stateScope: string | null = null): Promise<void> {
  const currentState: ISkillStateInfo = await getSkillStateAsync(skillName, stateScope);
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const fingerprintChanged: boolean = fingerprint !== null && fingerprint !== currentState.setupFingerprint;
  const setupAttempts: number = Math.min(
    MAX_AUTO_SETUP_ATTEMPTS,
    fingerprintChanged ? 1 : Math.max(1, currentState.setupAttempts + 1),
  );
  const state: ISkillStateInfo = _buildState(
    "setup-in-progress", null, null, now, currentState.missingDeps, currentState.manualStepsRequired,
    currentState.attemptedInstalls, fingerprint ?? currentState.setupFingerprint, setupAttempts, null,
  );

  await saveSkillStateAsync(skillName, state, stateScope);

  logger.debug(`Skill "${sanitizeSetupError(skillName)}" setup in progress`);
}

export async function markSkillNeedsSetupAsync(
  skillName: string,
  missingDeps: ISkillMissingDeps | null,
  manualSteps: string[],
  fingerprint: string | null = null,
  stateScope: string | null = null,
): Promise<void> {
  const currentState: ISkillStateInfo = await getSkillStateAsync(skillName, stateScope);
  const now: string = new Date().toISOString();
  const logger: LoggerService = LoggerService.getInstance();
  const fingerprintChanged: boolean = fingerprint !== null && fingerprint !== currentState.setupFingerprint;
  const needsSetup: boolean = manualSteps.length > 0 || hasMissingInstallDependencies(missingDeps);
  const setupAttempts: number = Math.min(
    MAX_AUTO_SETUP_ATTEMPTS,
    fingerprintChanged ? 0 : Math.max(0, currentState.setupAttempts),
  );
  const nextSetupAttemptAt: string | null = needsSetup && setupAttempts > 0 && setupAttempts < MAX_AUTO_SETUP_ATTEMPTS
    ? new Date(Date.now() + getSetupBackoffMs(setupAttempts)).toISOString()
    : null;
  const state: ISkillStateInfo = _buildState(
    needsSetup ? "needs-setup" : "missing-deps", null, null, now, missingDeps, manualSteps, [],
    fingerprint ?? currentState.setupFingerprint, setupAttempts, nextSetupAttemptAt,
  );

  await saveSkillStateAsync(skillName, state, stateScope);

  logger.info(`Skill "${sanitizeSetupError(skillName)}" needs setup`);
}


//#endregion Public Functions
