import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { ISkillInstallStep } from "../shared/types/index.js";
import { LoggerService } from "./logger.service.js";
import { DependencyCheckerService } from "./dependency-checker.service.js";

const execAsync = promisify(exec);

type AllowedInstallKind = "brew" | "node" | "go" | "uv" | "pacman" | "apt" | "download";

interface IInstallStepResult {
  success: boolean;
  error: string | null;
  installedBins: string[];
}

interface IInstallResult {
  success: boolean;
  installed: string[];
  manualStepsRequired: string[];
  error: string | null;
}

const DEFAULT_ALLOWED_KINDS: AllowedInstallKind[] = ["brew", "node", "go", "uv"];

const REQUIRES_SUDO_KINDS: AllowedInstallKind[] = ["pacman", "apt"];

export class SkillInstallerService {

  private static _instance: SkillInstallerService | null;
  private _logger: LoggerService;

  private constructor() {
    this._logger = LoggerService.getInstance();
  }

  public static getInstance(): SkillInstallerService {
    if (!SkillInstallerService._instance) {
      SkillInstallerService._instance = new SkillInstallerService();
    }

    return SkillInstallerService._instance;
  }

  public async executeInstallSteps(
    steps: ISkillInstallStep[],
    allowedKinds: AllowedInstallKind[] = DEFAULT_ALLOWED_KINDS,
    timeout: number = 300000,
  ): Promise<IInstallResult> {
    const result: IInstallResult = {
      success: true,
      installed: [],
      manualStepsRequired: [],
      error: null,
    };

    const depChecker = DependencyCheckerService.getInstance();

    for (const step of steps) {
      const isAllowed = allowedKinds.includes(step.kind as AllowedInstallKind);
      const requiresSudo = REQUIRES_SUDO_KINDS.includes(step.kind as AllowedInstallKind);

      if (!isAllowed || requiresSudo) {
        const manualInstruction = this.getManualInstructions(step);
        result.manualStepsRequired.push(manualInstruction);
        this._logger.info(`Install step "${step.id}" requires manual action (${step.kind})`);

        continue;
      }

      this._logger.info(`Executing install step: ${step.id} (${step.kind})`);

      try {
        const stepResult = await this.executeInstallStep(step, timeout);

        if (stepResult.success) {
          result.installed.push(...stepResult.installedBins);
          this._logger.info(`Install step "${step.id}" completed successfully`);
        } else {
          result.success = false;
          result.error = `Step "${step.id}" failed: ${stepResult.error}`;

          break;
        }
      } catch (err) {
        result.success = false;
        result.error = `Step "${step.id}" threw error: ${err instanceof Error ? err.message : String(err)}`;

        break;
      }
    }

    if (result.success && result.installed.length > 0) {
      depChecker.clearCache();

      for (const bin of result.installed) {
        const exists = await depChecker.checkBinary(bin);

        if (!exists) {
          result.success = false;
          result.error = `Binary "${bin}" not found after installation`;

          break;
        }
      }
    }

    return result;
  }

  private async executeInstallStep(
    step: ISkillInstallStep,
    timeout: number,
  ): Promise<IInstallStepResult> {
    switch (step.kind) {
      case "brew":
        return this.installBrew(step, timeout);
      case "node":
        return this.installNode(step, timeout);
      case "go":
        return this.installGo(step, timeout);
      case "uv":
        return this.installUv(step, timeout);
      default:
        return {
          success: false,
          error: `Unsupported install kind: ${step.kind}`,
          installedBins: [],
        };
    }
  }

  private async installBrew(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
    const formula = step.formula || step.package;

    if (!formula) {
      return { success: false, error: "No formula specified for brew install", installedBins: [] };
    }

    try {
      await execAsync(`brew install ${formula}`, { timeout });
      const bins = step.bins.length > 0 ? step.bins : [formula];

      return { success: true, error: null, installedBins: bins };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        installedBins: [],
      };
    }
  }

  private async installNode(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
    const pkg = step.package || step.formula;

    if (!pkg) {
      return { success: false, error: "No package specified for npm install", installedBins: [] };
    }

    try {
      await execAsync(`npm install -g ${pkg}`, { timeout });
      const bins = step.bins.length > 0 ? step.bins : [pkg.replace(/^@[^/]+\//, "").replace(/-.*/, "")];

      return { success: true, error: null, installedBins: bins };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        installedBins: [],
      };
    }
  }

  private async installGo(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
    const pkg = step.package || step.formula;

    if (!pkg) {
      return { success: false, error: "No package specified for go install", installedBins: [] };
    }

    try {
      await execAsync(`go install ${pkg}@latest`, { timeout });
      const bins = step.bins.length > 0 ? step.bins : [pkg.split("/").pop() || pkg];

      return { success: true, error: null, installedBins: bins };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        installedBins: [],
      };
    }
  }

  private async installUv(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
    const pkg = step.package || step.formula;

    if (!pkg) {
      return { success: false, error: "No package specified for uv pip install", installedBins: [] };
    }

    try {
      await execAsync(`uv pip install ${pkg}`, { timeout });
      const bins = step.bins;

      return { success: true, error: null, installedBins: bins };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        installedBins: [],
      };
    }
  }

  public getManualInstructions(step: ISkillInstallStep): string {
    const label = step.label || `Install ${step.formula || step.package || step.id}`;

    switch (step.kind) {
      case "pacman": {
        const formula = step.formula || step.package;
        const cmd = `sudo pacman -S ${formula}`;

        return `${label}: \`${cmd}\``;
      }
      case "apt": {
        const formula = step.formula || step.package;
        const cmd = `sudo apt install -y ${formula}`;

        return `${label}: \`${cmd}\``;
      }
      case "download":
        return `${label}: Download and install manually (see skill documentation)`;
      default:
        return `${label}: Manual installation required`;
    }
  }

  public getMissingDepsInstructions(missing: { bins: string[]; env: string[]; config: string[] }): string[] {
    const instructions: string[] = [];

    for (const bin of missing.bins) {
      instructions.push(`Install binary: \`${bin}\``);
    }

    for (const envVar of missing.env) {
      instructions.push(`Set environment variable: \`${envVar}=<value>\``);
    }

    for (const configPath of missing.config) {
      instructions.push(`Configure: \`${configPath}\` in BetterClaw config`);
    }

    return instructions;
  }
}
