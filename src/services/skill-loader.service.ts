import fs from "node:fs/promises";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ISkill, ISkillStateInfo } from "../shared/types/index.js";
import { getSkillsDir } from "../utils/paths.js";
import { DEFAULT_ALLOWED_INSTALL_KINDS, DEFAULT_SKILL_INSTALL_TIMEOUT_MS, MAX_DEPENDENCY_CHECKS_PER_REFRESH, MAX_SKILL_INSTALL_STEPS, MAX_SKILL_WATCHERS, MAX_SKILLS_PER_ROOT, SKILL_FILE_NAME, type AllowedInstallKind } from "../shared/constants.js";
import { loadSkillInstructionsAsync as readSkillInstructionsAsync, parseSkillFrontmatterAsync } from "../skills/parser.js";
import { extractErrorMessage } from "../utils/error.js";
import * as skillState from "../helpers/skill-state.js";
import * as dependencyChecker from "../helpers/dependency-checker.js";
import * as skillInstaller from "../helpers/skill-installer.js";
import { LoggerService } from "./logger.service.js";

const PROCESS_START_TIME_MS: number = Date.now();
const SETUP_CLAIM_GRACE_MS: number = 60_000;

export class SkillLoaderService {

  //#region Data members

  private static _instance: SkillLoaderService | null;
  private _logger: LoggerService;
  private _skills: Map<string, ISkill>;
  private _roots: string[] = [];
  private _autoSetupRoots: Set<string> = new Set();
  private _skipOsCheck = false;
  private _watchers: FSWatcher[] = [];
  private _refreshTimer: NodeJS.Timeout | null = null;
  private _refreshInFlight: Promise<void> | null = null;
  private _watchGeneration: number = 0;
  private _allowedInstallKinds: AllowedInstallKind[] = [...DEFAULT_ALLOWED_INSTALL_KINDS];
  private _dependencyConfig: Record<string, unknown> = {};
  private _installTimeout: number = DEFAULT_SKILL_INSTALL_TIMEOUT_MS;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
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
    const manualSteps: string[] = [];

    for (const step of installSteps) {
      if (skillInstaller.isManualInstallStep(step, this._allowedInstallKinds)) {
        manualSteps.push(skillInstaller.getSkillManualInstructions(step));
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

  public async loadAllSkillsAsync(
    additionalDirs: string[] = [],
    skipOsCheck: boolean = false,
    allowedInstallKinds: AllowedInstallKind[] = DEFAULT_ALLOWED_INSTALL_KINDS,
    dependencyConfig: Record<string, unknown> = {},
    installTimeout: number = DEFAULT_SKILL_INSTALL_TIMEOUT_MS,
  ): Promise<void> {
    this.stopWatching();
    this._skipOsCheck = skipOsCheck;
    this._allowedInstallKinds = [...allowedInstallKinds];
    this._dependencyConfig = dependencyConfig;
    this._installTimeout = installTimeout;
    const configuredDirs = additionalDirs.filter((dir) => dir.trim().length > 0);
    const roots = [getSkillsDir(), path.join(process.cwd(), ".agents", "skills"), path.join(os.homedir(), ".agents", "skills"), ...configuredDirs];
    this._roots = [...new Set(roots.map((root) => this._resolveRoot(root)))];
    this._autoSetupRoots = new Set([this._resolveRoot(getSkillsDir()), ...configuredDirs.map((root) => this._resolveRoot(root))]);
    await this.refreshAsync();
    this._logger.info(`Loaded ${this._skills.size} skill(s) total`);
  }

  public async refreshAsync(): Promise<void> {
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = this._refreshCatalogAsync().finally(() => { this._refreshInFlight = null; });
    return this._refreshInFlight;
  }

  public async startWatching(): Promise<void> {
    this.stopWatching();
    const watchGeneration: number = this._watchGeneration;
    let watchedSkillCount = 0;
    for (const root of this._roots) {
      if (this._watchGeneration !== watchGeneration) return;
      try {
        const watcher = watch(root, () => this._scheduleRefresh());
        this._watchers.push(watcher);
        watcher.on("error", () => watcher.close());
        const entries = await fs.readdir(root, { withFileTypes: true });
        if (this._watchGeneration !== watchGeneration) return;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (watchedSkillCount >= MAX_SKILL_WATCHERS) break;
          watchedSkillCount += 1;
          try {
            const skillWatcher = watch(path.join(root, entry.name), () => this._scheduleRefresh());
            this._watchers.push(skillWatcher);
            skillWatcher.on("error", () => skillWatcher.close());
          } catch { /* Skill directories can disappear during refresh. */ }
        }
      } catch { /* Roots may not exist yet. */ }
    }
  }

  public stopWatching(): void {
    for (const watcher of this._watchers) watcher.close();
    this._watchGeneration += 1;
    this._watchers = [];
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
  }

  private _scheduleRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    const watchGeneration: number = this._watchGeneration;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this._watchGeneration !== watchGeneration) return;
      void this.refreshAsync()
        .then(() => {
          if (this._watchGeneration === watchGeneration) {
            return this.startWatching();
          }
          return;
        })
        .catch((error: unknown) => {
          this._logger.error("Skill refresh failed", { error: extractErrorMessage(error) });
        });
    }, 150);
  }

  public getSkill(name: string): ISkill | undefined {
    return this._skills.get(name);
  }

  public getAllSkills(): ISkill[] {
    return Array.from(this._skills.values());
  }

  public getAvailableSkill(name: string): ISkill | undefined {
    const skill = this._skills.get(name);
    return skill && skill.state.state === "ready" && !skill.frontmatter.disableModelInvocation ? skill : undefined;
  }


  public async loadSkillInstructionsAsync(name: string): Promise<string | undefined> {
    const skill = this.getAvailableSkill(name);
    return skill ? readSkillInstructionsAsync(skill.skillFilePath) : undefined;
  }

  public getAvailableSkills(): ISkill[] {
    return Array.from(this._skills.values()).filter((skill: ISkill) => skill.state.state === "ready" && !skill.frontmatter.disableModelInvocation);
  }

  //#endregion Public methods

  //#region Private methods

  private _resolveRoot(root: string): string {
    const expandedRoot: string = root.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expandedRoot);
  }

  private _getStateScope(dir: string): string | null {
    const resolvedRoot: string = this._resolveRoot(dir);
    return resolvedRoot === this._resolveRoot(getSkillsDir()) ? null : resolvedRoot;
  }

  private async _refreshCatalogAsync(): Promise<void> {
    const next = new Map<string, ISkill>();
    let remainingDependencyChecks: number = MAX_DEPENDENCY_CHECKS_PER_REFRESH;
    for (let rootIndex = 0; rootIndex < this._roots.length; rootIndex += 1) {
      const rootsRemaining: number = this._roots.length - rootIndex;
      const allocation: number = remainingDependencyChecks > 0
        ? Math.min(remainingDependencyChecks, Math.max(1, Math.floor(remainingDependencyChecks / rootsRemaining)))
        : 0;
      const dependencyBudget: dependencyChecker.IDependencyCheckBudget = dependencyChecker.createDependencyCheckBudget(allocation);
      const loaded = await this._loadSkillsFromDirAsync(this._roots[rootIndex], this._skipOsCheck, dependencyBudget);
      remainingDependencyChecks -= allocation - dependencyBudget.remaining;
      for (const [name, skill] of loaded) {
        if (!next.has(name)) next.set(name, skill);
      }
    }
    this._skills = next;
  }

  private async _loadSkillsFromDirAsync(
    dir: string,
    skipOsCheck: boolean = false,
    dependencyBudget: dependencyChecker.IDependencyCheckBudget = dependencyChecker.createDependencyCheckBudget(),
  ): Promise<Map<string, ISkill>> {
    const loaded = new Map<string, ISkill>();
    let discoveredSkillCount = 0;
    let entries: Dirent[];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      const message = `Skills directory not found or not readable: "${dir}"`;
      if (this._autoSetupRoots.has(this._resolveRoot(dir))) {
        this._logger.warn(message);
      } else {
        this._logger.debug(message);
      }

      return loaded;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (discoveredSkillCount >= MAX_SKILLS_PER_ROOT) {
        this._logger.warn(`Skill directory limit reached for root "${dir}"; remaining entries were skipped`);
        break;
      }
      discoveredSkillCount += 1;

      const skillName: string = entry.name;
      const displaySkillName: string = skillState.sanitizeSetupError(skillName);
      const skillFilePath: string = path.join(dir, skillName, SKILL_FILE_NAME);
      const skillDirectory: string = path.join(dir, skillName);

      try {
        await fs.access(skillFilePath);
      } catch {
        this._logger.debug(`Skipping directory "${displaySkillName}" — no ${SKILL_FILE_NAME} found`);

        continue;
      }

      const realSkillDirectory: string = await fs.realpath(skillDirectory);
      const realSkillFilePath: string = await fs.realpath(skillFilePath);
      if (!realSkillFilePath.startsWith(realSkillDirectory + path.sep)) {
        this._logger.warn(`Skipping skill "${displaySkillName}" — ${SKILL_FILE_NAME} resolves outside its directory`);
        continue;
      }

      try {
        const frontmatter = await parseSkillFrontmatterAsync(realSkillFilePath);
        const stateScope: string | null = this._getStateScope(dir);
        const savedState: ISkillStateInfo = await skillState.getSkillStateAsync(skillName, stateScope);

        const skill: ISkill = {
          name: skillName,
          frontmatter,
          directory: realSkillDirectory,
          skillFilePath: realSkillFilePath,
          stateScope,
          state: savedState,
          autoSetupAllowed: this._autoSetupRoots.has(this._resolveRoot(dir)),
        };

        const fingerprint = skillState.getSkillSetupFingerprint(skill);
        const sameFingerprint = savedState.setupFingerprint === fingerprint;
        const stateIsFromManagedRoot = stateScope === null;
        const shouldReconcile = savedState.state !== "ready" || !sameFingerprint || stateIsFromManagedRoot;
        if (shouldReconcile) {
          const determinedState = await this._determineSkillStateAsync(skill, skipOsCheck, dependencyBudget);
          if (determinedState === null) {
            skill.state = savedState;
            if (!loaded.has(skillName)) loaded.set(skillName, skill);
            this._logger.debug(`Deferred dependency reconciliation for "${displaySkillName}"; check budget exhausted`);
            continue;
          }
          const now = Date.now();
          const retryTimestamp = savedState.nextSetupAttemptAt ? Date.parse(savedState.nextSetupAttemptAt) : Number.NaN;
          const latestExpectedRetryTimestamp = now + skillState.getSetupBackoffMs(skillState.MAX_AUTO_SETUP_ATTEMPTS);
          const retryDue = !savedState.nextSetupAttemptAt
            || Number.isNaN(retryTimestamp)
            || now >= retryTimestamp
            || retryTimestamp > latestExpectedRetryTimestamp;
          const attempts = Math.max(0, savedState.setupAttempts);
          const setupStartedAt = savedState.lastCheckedAt ? Date.parse(savedState.lastCheckedAt) : Number.NaN;
          const liveSetupInProgress = savedState.state === "setup-in-progress"
            && !Number.isNaN(setupStartedAt)
            && setupStartedAt >= PROCESS_START_TIME_MS
            && setupStartedAt <= now
            && now - setupStartedAt <= this._installTimeout * MAX_SKILL_INSTALL_STEPS + SETUP_CLAIM_GRACE_MS;
          let shouldPersistState = false;

          if (determinedState.state === "ready") {
            skill.state = { ...determinedState, setupFingerprint: fingerprint, setupAttempts: 0, nextSetupAttemptAt: null };
            shouldPersistState = savedState.state !== "ready" || !sameFingerprint;
          } else if (!sameFingerprint) {
            skill.state = { ...determinedState, setupFingerprint: fingerprint, setupAttempts: 0, nextSetupAttemptAt: null };
            shouldPersistState = true;
          } else if (liveSetupInProgress) {
            skill.state = savedState;
          } else if (savedState.state === "setup-in-progress") {
            const interruptedState: ISkillStateInfo = {
              ...determinedState,
              state: "setup-failed",
              setupFingerprint: fingerprint,
              setupAttempts: Math.min(skillState.MAX_AUTO_SETUP_ATTEMPTS, Math.max(1, attempts)),
              nextSetupAttemptAt: attempts >= skillState.MAX_AUTO_SETUP_ATTEMPTS ? null : new Date().toISOString(),
              lastError: "Skill setup interrupted before completion",
            };
            if (attempts >= skillState.MAX_AUTO_SETUP_ATTEMPTS) {
              skill.state = interruptedState;
              shouldPersistState = true;
            } else {
              try {
                await skillState.saveSkillStateAsync(skillName, interruptedState, stateScope);
              } catch (stateError: unknown) {
                this._logger.warn(`Failed to persist interrupted state for skill "${displaySkillName}"`, {
                  error: skillState.sanitizeSetupError(extractErrorMessage(stateError)),
                });
              }
              skill.state = { ...interruptedState, state: "needs-setup", nextSetupAttemptAt: null };
            }
          } else if (savedState.state === "setup-failed" && (!retryDue || attempts >= skillState.MAX_AUTO_SETUP_ATTEMPTS)) {
            const nextSetupAttemptAt = attempts >= skillState.MAX_AUTO_SETUP_ATTEMPTS ? null : savedState.nextSetupAttemptAt;
            skill.state = {
              ...determinedState,
              state: "setup-failed",
              setupFingerprint: fingerprint,
              setupAttempts: attempts,
              nextSetupAttemptAt,
              lastError: savedState.lastError,
            };
            shouldPersistState = savedState.nextSetupAttemptAt !== nextSetupAttemptAt;
          } else {
            const nextSetupAttemptAt = savedState.state === "needs-setup" && !retryDue ? savedState.nextSetupAttemptAt : null;
            skill.state = { ...determinedState, setupFingerprint: fingerprint, setupAttempts: attempts, nextSetupAttemptAt };
            shouldPersistState = savedState.state !== determinedState.state
              || savedState.setupFingerprint !== fingerprint
              || savedState.nextSetupAttemptAt !== nextSetupAttemptAt;
          }

          if (shouldPersistState) {
            try {
              await skillState.saveSkillStateAsync(skillName, skill.state, stateScope);
            } catch (stateError: unknown) {
              this._logger.warn(`Failed to persist state for skill "${displaySkillName}"`, {
                error: skillState.sanitizeSetupError(extractErrorMessage(stateError)),
              });
            }
          }
        }

        if (!loaded.has(skillName)) loaded.set(skillName, skill);

        this._logger.debug(`Loaded skill "${displaySkillName}"`, { state: skill.state.state });
      } catch (error: unknown) {
        const message: string = skillState.sanitizeSetupError(extractErrorMessage(error));

        this._logger.warn(`Failed to parse skill "${displaySkillName}": ${message}`);
      }
    }
    return loaded;
  }

  private async _determineSkillStateAsync(
    skill: ISkill,
    skipOsCheck: boolean,
    dependencyBudget: dependencyChecker.IDependencyCheckBudget,
  ): Promise<ISkillStateInfo | null> {
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
        setupFingerprint: null,
        setupAttempts: 0,
        nextSetupAttemptAt: null,
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
        setupFingerprint: null,
        setupAttempts: 0,
        nextSetupAttemptAt: null,
      };
    }

    const depResult = await dependencyChecker.checkRequirementsAsync(requires, this._dependencyConfig, dependencyBudget);
    if (!depResult.complete) {
      return null;
    }

    if (depResult.satisfied) {
      return {
        state: "ready",
        lastError: null,
        setupAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        missingDeps: null,
        manualStepsRequired: [],
        attemptedInstalls: [],
        setupFingerprint: null,
        setupAttempts: 0,
        nextSetupAttemptAt: null,
      };
    }

    const hasInstallSteps = this.hasInstallSteps(skill);
    const manualSteps = hasInstallSteps ? this.getManualSteps(skill) : [];
    const hasMissingInstallDependency = dependencyChecker.hasMissingInstallDependencies(depResult.missing);
    if ((hasInstallSteps && hasMissingInstallDependency) || manualSteps.length > 0) {
      return {
        state: "needs-setup",
        lastError: null,
        setupAt: null,
        lastCheckedAt: new Date().toISOString(),
        missingDeps: depResult.missing,
        manualStepsRequired: manualSteps,
        attemptedInstalls: [],
        setupFingerprint: null,
        setupAttempts: 0,
        nextSetupAttemptAt: null,
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
      setupFingerprint: null,
      setupAttempts: 0,
      nextSetupAttemptAt: null,
    };
  }

  //#endregion Private methods
}
