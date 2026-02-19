import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";

import { ISkill, ISkillStateInfo } from "../shared/types/index.js";
import { getSkillsDir } from "../utils/paths.js";
import { SKILL_FILE_NAME } from "../shared/constants.js";
import { parseSkillFileAsync, IParsedSkill } from "../skills/parser.js";
import { SkillStateService } from "./skill-state.service.js";
import { LoggerService } from "./logger.service.js";

export class SkillLoaderService {

  //#region Data members

  private static _instance: SkillLoaderService | null;
  private _logger: LoggerService;
  private _skillStateService: SkillStateService;
  private _skills: Map<string, ISkill>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._skillStateService = SkillStateService.getInstance();
    this._skills = new Map<string, ISkill>();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): SkillLoaderService {
    if (!SkillLoaderService._instance) {
      SkillLoaderService._instance = new SkillLoaderService();
    }

    return SkillLoaderService._instance;
  }

  public async loadAllSkillsAsync(additionalDirs?: string[]): Promise<void> {
    const defaultDir: string = getSkillsDir();

    await this._loadSkillsFromDirAsync(defaultDir);

    if (additionalDirs) {
      for (const dir of additionalDirs) {
        await this._loadSkillsFromDirAsync(dir);
      }
    }

    this._logger.info(`Loaded ${this._skills.size} skill(s) total`);
  }

  public getSkill(name: string): ISkill | undefined {
    return this._skills.get(name);
  }

  public getAllSkills(): ISkill[] {
    return Array.from(this._skills.values());
  }

  public getAvailableSkills(): ISkill[] {
    return Array.from(this._skills.values()).filter(
      (skill: ISkill) =>
        skill.state.state === "setuped" &&
        skill.frontmatter.disableModelInvocation === false,
    );
  }

  //#endregion Public methods

  //#region Private methods

  private async _loadSkillsFromDirAsync(dir: string): Promise<void> {
    let entries: Dirent[];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      this._logger.warn(`Skills directory not found or not readable: "${dir}"`);

      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillName: string = entry.name;
      const skillFilePath: string = path.join(dir, skillName, SKILL_FILE_NAME);

      try {
        await fs.access(skillFilePath);
      } catch {
        this._logger.debug(`Skipping directory "${skillName}" — no ${SKILL_FILE_NAME} found`);

        continue;
      }

      try {
        const parsed: IParsedSkill = await parseSkillFileAsync(skillFilePath);
        const state: ISkillStateInfo = await this._skillStateService.getStateAsync(skillName);

        const skill: ISkill = {
          name: skillName,
          frontmatter: parsed.frontmatter,
          instructions: parsed.instructions,
          directory: path.join(dir, skillName),
          state,
        };

        this._skills.set(skillName, skill);

        this._logger.debug(`Loaded skill "${skillName}"`, { state: state.state });
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);

        this._logger.warn(`Failed to parse skill "${skillName}": ${message}`);
      }
    }
  }

  //#endregion Private methods
}
