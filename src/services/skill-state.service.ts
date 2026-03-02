import fs from "node:fs/promises";

import { ISkillStateInfo } from "../shared/types/index.js";
import { skillStateInfoSchema } from "../shared/schemas/index.js";
import { LoggerService } from "./logger.service.js";
import { getSkillStatePath, getSkillDir, ensureDirectoryExistsAsync } from "../utils/paths.js";

export class SkillStateService {

  //#region Data members

  private static _instance: SkillStateService | null;
  private _logger: LoggerService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): SkillStateService {
    if (!SkillStateService._instance) {
      SkillStateService._instance = new SkillStateService();
    }

    return SkillStateService._instance;
  }

  public async getStateAsync(skillName: string): Promise<ISkillStateInfo> {
    const filePath: string = getSkillStatePath(skillName);

    try {
      const content: string = await fs.readFile(filePath, "utf-8");
      const raw: unknown = JSON.parse(content);
      const parsed: ISkillStateInfo = skillStateInfoSchema.parse(raw);

      return parsed;
    } catch {
      this._logger.debug(`No existing state found for skill "${skillName}", returning default state`);

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

  public async saveStateAsync(skillName: string, state: ISkillStateInfo): Promise<void> {
    const skillDir: string = getSkillDir(skillName);

    await ensureDirectoryExistsAsync(skillDir);

    const filePath: string = getSkillStatePath(skillName);
    const content: string = JSON.stringify(state, null, 2);

    await fs.writeFile(filePath, content, "utf-8");

    this._logger.debug(`Saved state for skill "${skillName}"`, { state: state.state });
  }

  public async markSetupCompleteAsync(skillName: string): Promise<void> {
    const now: string = new Date().toISOString();
    const state: ISkillStateInfo = {
      state: "ready",
      lastError: null,
      setupAt: now,
      lastCheckedAt: now,
      missingDeps: null,
      manualStepsRequired: [],
      attemptedInstalls: [],
    };

    await this.saveStateAsync(skillName, state);

    this._logger.info(`Skill "${skillName}" marked as ready`);
  }

  public async markSetupErrorAsync(skillName: string, error: string): Promise<void> {
    const currentState = await this.getStateAsync(skillName);
    const now: string = new Date().toISOString();
    const state: ISkillStateInfo = {
      state: "setup-failed",
      lastError: error,
      setupAt: null,
      lastCheckedAt: now,
      missingDeps: currentState.missingDeps,
      manualStepsRequired: currentState.manualStepsRequired,
      attemptedInstalls: currentState.attemptedInstalls,
    };

    await this.saveStateAsync(skillName, state);

    this._logger.warn(`Skill "${skillName}" setup failed: ${error}`);
  }

  public async markSetupInProgressAsync(skillName: string): Promise<void> {
    const currentState = await this.getStateAsync(skillName);
    const now: string = new Date().toISOString();
    const state: ISkillStateInfo = {
      state: "setup-in-progress",
      lastError: null,
      setupAt: null,
      lastCheckedAt: now,
      missingDeps: currentState.missingDeps,
      manualStepsRequired: currentState.manualStepsRequired,
      attemptedInstalls: currentState.attemptedInstalls,
    };

    await this.saveStateAsync(skillName, state);

    this._logger.debug(`Skill "${skillName}" setup in progress`);
  }

  public async markNeedsSetupAsync(
    skillName: string,
    missingDeps: ISkillStateInfo["missingDeps"],
    manualSteps: string[],
  ): Promise<void> {
    const now: string = new Date().toISOString();
    const state: ISkillStateInfo = {
      state: "needs-setup",
      lastError: null,
      setupAt: null,
      lastCheckedAt: now,
      missingDeps,
      manualStepsRequired: manualSteps,
      attemptedInstalls: [],
    };

    await this.saveStateAsync(skillName, state);

    this._logger.info(`Skill "${skillName}" needs setup`);
  }

  public async addAttemptedInstallAsync(skillName: string, stepId: string): Promise<void> {
    const currentState = await this.getStateAsync(skillName);
    const attemptedInstalls = [...(currentState.attemptedInstalls || []), stepId];
    const state: ISkillStateInfo = {
      ...currentState,
      attemptedInstalls,
      lastCheckedAt: new Date().toISOString(),
    };

    await this.saveStateAsync(skillName, state);
  }

  //#endregion Public methods
}
