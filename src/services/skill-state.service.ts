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
      state: "setuped",
      lastError: null,
      setupAt: now,
      lastCheckedAt: now,
    };

    await this.saveStateAsync(skillName, state);

    this._logger.info(`Skill "${skillName}" marked as setup complete`);
  }

  public async markSetupErrorAsync(skillName: string, error: string): Promise<void> {
    const now: string = new Date().toISOString();
    const state: ISkillStateInfo = {
      state: "error-during-setup",
      lastError: error,
      setupAt: null,
      lastCheckedAt: now,
    };

    await this.saveStateAsync(skillName, state);

    this._logger.warn(`Skill "${skillName}" encountered setup error: ${error}`);
  }

  //#endregion Public methods
}
