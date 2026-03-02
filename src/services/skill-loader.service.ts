import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";

import { ISkill, ISkillStateInfo } from "../shared/types/index.js";
import { getSkillsDir } from "../utils/paths.js";
import { SKILL_FILE_NAME } from "../shared/constants.js";
import { parseSkillFileAsync, IParsedSkill } from "../skills/parser.js";
import { SkillStateService } from "./skill-state.service.js";
import { DependencyCheckerService } from "./dependency-checker.service.js";
import { SkillInstallerService } from "./skill-installer.service.js";
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

  public getCurrentOs(): "macos" | "linux" | "windows" {
    switch (process.platform) {
      case "darwin":
        return "macos";
      case "linux":
        return "linux";
      case "win32":
        return "windows";
      default:
        return "linux";
    }
  }

  public isOsSupported(skillOs?: string[]): boolean {
    if (!skillOs || skillOs.length === 0) {
      return true;
    }

    const currentOs = this.getCurrentOs();

    return skillOs.includes(currentOs);
  }

  public hasInstallSteps(skill: ISkill): boolean {
    const installSteps = skill.frontmatter.metadata?.openclaw?.install;

    return installSteps !== undefined && installSteps.length > 0;
  }

  public getManualSteps(skill: ISkill): string[] {
    const installSteps = skill.frontmatter.metadata?.openclaw?.install || [];
    const installer = SkillInstallerService.getInstance();
    const manualSteps: string[] = [];

    for (const step of installSteps) {
      if (step.kind === "pacman" || step.kind === "apt" || step.kind === "download") {
        manualSteps.push(installer.getManualInstructions(step));
      }
    }

    return manualSteps;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): SkillLoaderService {
    if (!SkillLoaderService._instance) {
      SkillLoaderService._instance = new SkillLoaderService();
    }

    return SkillLoaderService._instance;
  }

  public async loadAllSkillsAsync(additionalDirs?: string[], skipOsCheck: boolean = false): Promise<void> {
    const defaultDir: string = getSkillsDir();

    await this._loadSkillsFromDirAsync(defaultDir, skipOsCheck);

    if (additionalDirs) {
      for (const dir of additionalDirs) {
        await this._loadSkillsFromDirAsync(dir, skipOsCheck);
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
        skill.state.state === "ready" &&
        skill.frontmatter.disableModelInvocation === false,
    );
  }

  //#endregion Public methods

  //#region Private methods

  private async _loadSkillsFromDirAsync(dir: string, skipOsCheck: boolean = false): Promise<void> {
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
        const savedState: ISkillStateInfo = await this._skillStateService.getStateAsync(skillName);

        const skill: ISkill = {
          name: skillName,
          frontmatter: parsed.frontmatter,
          instructions: parsed.instructions,
          directory: path.join(dir, skillName),
          state: savedState,
        };

        if (savedState.state === "setup-in-progress" || savedState.state === "setup-failed") {
          skill.state = await this._determineSkillStateAsync(skill, skipOsCheck);
        } else if (savedState.state === "never-touched") {
          skill.state = await this._determineSkillStateAsync(skill, skipOsCheck);
        } else if (savedState.state === "needs-setup") {
          skill.state = await this._determineSkillStateAsync(skill, skipOsCheck);
        }

        this._skills.set(skillName, skill);

        this._logger.debug(`Loaded skill "${skillName}"`, { state: skill.state.state });
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);

        this._logger.warn(`Failed to parse skill "${skillName}": ${message}`);
      }
    }
  }

  private async _determineSkillStateAsync(skill: ISkill, skipOsCheck: boolean): Promise<ISkillStateInfo> {
    const osRestrictions = skill.frontmatter.metadata?.openclaw?.os;

    if (!skipOsCheck && !this.isOsSupported(osRestrictions)) {
      return {
        state: "os-unsupported",
        lastError: null,
        setupAt: null,
        lastCheckedAt: new Date().toISOString(),
        missingDeps: null,
        manualStepsRequired: [],
        attemptedInstalls: [],
      };
    }

    const requires = skill.frontmatter.metadata?.openclaw?.requires;

    if (!requires) {
      return {
        state: "ready",
        lastError: null,
        setupAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        missingDeps: null,
        manualStepsRequired: [],
        attemptedInstalls: [],
      };
    }

    const depChecker = DependencyCheckerService.getInstance();
    const depResult = await depChecker.checkRequirements(requires);

    if (depResult.satisfied) {
      return {
        state: "ready",
        lastError: null,
        setupAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        missingDeps: null,
        manualStepsRequired: [],
        attemptedInstalls: [],
      };
    }

    if (this.hasInstallSteps(skill)) {
      const manualSteps = this.getManualSteps(skill);

      return {
        state: "needs-setup",
        lastError: null,
        setupAt: null,
        lastCheckedAt: new Date().toISOString(),
        missingDeps: depResult.missing,
        manualStepsRequired: manualSteps,
        attemptedInstalls: [],
      };
    }

    return {
      state: "missing-deps",
      lastError: null,
      setupAt: null,
      lastCheckedAt: new Date().toISOString(),
      missingDeps: depResult.missing,
      manualStepsRequired: [],
      attemptedInstalls: [],
    };
  }

  //#endregion Private methods
}
