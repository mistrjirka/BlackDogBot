import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { ISkillInstallStep } from "../shared/types/index.js";
import { LoggerService } from "../services/logger.service.js";
import { clearDependencyCache, checkBinaryAsync } from "./dependency-checker.js";

//#region Types

const execAsync = promisify(exec);

type AllowedInstallKind = "brew" | "node" | "go" | "uv" | "pacman" | "apt" | "download";
export type SkillInstallKind = AllowedInstallKind;

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

//#endregion Types

//#region Constants

const DEFAULT_ALLOWED_KINDS: AllowedInstallKind[] = ["brew", "node", "go", "uv"];

const REQUIRES_SUDO_KINDS: AllowedInstallKind[] = ["pacman", "apt"];

//#endregion Constants

//#region Public Functions

export async function executeSkillInstallStepsAsync(
  steps: ISkillInstallStep[],
  allowedKinds: AllowedInstallKind[] = DEFAULT_ALLOWED_KINDS,
  timeout: number = 300000,
): Promise<IInstallResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const result: IInstallResult = {
    success: true,
    installed: [],
    manualStepsRequired: [],
    error: null,
  };

  for (const step of steps) {
    const isAllowed: boolean = allowedKinds.includes(step.kind as AllowedInstallKind);
    const requiresSudo: boolean = REQUIRES_SUDO_KINDS.includes(step.kind as AllowedInstallKind);

    if (!isAllowed || requiresSudo) {
      const manualInstruction: string = getSkillManualInstructions(step);
      result.manualStepsRequired.push(manualInstruction);
      logger.info(`Install step "${step.id}" requires manual action (${step.kind})`);

      continue;
    }

    logger.info(`Executing install step: ${step.id} (${step.kind})`);

    try {
      const stepResult: IInstallStepResult = await executeInstallStepAsync(step, timeout);

      if (stepResult.success) {
        result.installed.push(...stepResult.installedBins);
        logger.info(`Install step "${step.id}" completed successfully`);
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
    clearDependencyCache();

    for (const bin of result.installed) {
      const exists: boolean = await checkBinaryAsync(bin);

      if (!exists) {
        result.success = false;
        result.error = `Binary "${bin}" not found after installation`;

        break;
      }
    }
  }

  return result;
}

export function getSkillManualInstructions(step: ISkillInstallStep): string {
  const label: string = step.label || `Install ${step.formula || step.package || step.id}`;

  switch (step.kind) {
    case "pacman": {
      const formula: string | undefined = step.formula ?? step.package ?? undefined;
      const cmd: string = `sudo pacman -S ${formula}`;

      return `${label}: \`${cmd}\``;
    }
    case "apt": {
      const formula: string | undefined = step.formula ?? step.package ?? undefined;
      const cmd: string = `sudo apt install -y ${formula}`;

      return `${label}: \`${cmd}\``;
    }
    case "download":
      return `${label}: Download and install manually (see skill documentation)`;
    default:
      return `${label}: Manual installation required`;
  }
}

export function getSkillMissingDepsInstructions(missing: { bins: string[]; env: string[]; config: string[] }): string[] {
  const instructions: string[] = [];

  for (const bin of missing.bins) {
    instructions.push(`Install binary: \`${bin}\``);
  }

  for (const envVar of missing.env) {
    instructions.push(`Set environment variable: \`${envVar}=<value>\``);
  }

  for (const configPath of missing.config) {
    instructions.push(`Configure: \`${configPath}\` in BlackDogBot config`);
  }

  return instructions;
}

//#endregion Public Functions

//#region Private Functions

async function executeInstallStepAsync(
  step: ISkillInstallStep,
  timeout: number,
): Promise<IInstallStepResult> {
  switch (step.kind) {
    case "brew":
      return installBrewAsync(step, timeout);
    case "node":
      return installNodeAsync(step, timeout);
    case "go":
      return installGoAsync(step, timeout);
    case "uv":
      return installUvAsync(step, timeout);
    default:
      return {
        success: false,
        error: `Unsupported install kind: ${step.kind}`,
        installedBins: [],
      };
  }
}

async function installBrewAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const formula: string | undefined = step.formula ?? step.package ?? undefined;

  if (!formula) {
    return { success: false, error: "No formula specified for brew install", installedBins: [] };
  }

  try {
    await execAsync(`brew install ${formula}`, { timeout });
    const bins: string[] = step.bins.length > 0 ? step.bins : [formula];

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      installedBins: [],
    };
  }
}

async function installNodeAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const pkg: string | undefined = step.package ?? step.formula ?? undefined;

  if (!pkg) {
    return { success: false, error: "No package specified for npm install", installedBins: [] };
  }

  try {
    await execAsync(`npm install -g ${pkg}`, { timeout });
    const bins: string[] = step.bins.length > 0 ? step.bins : [pkg.replace(/^@[^/]+\//, "").replace(/-.*/, "")];

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      installedBins: [],
    };
  }
}

async function installGoAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const pkg: string | undefined = step.package ?? step.formula ?? undefined;

  if (!pkg) {
    return { success: false, error: "No package specified for go install", installedBins: [] };
  }

  try {
    await execAsync(`go install ${pkg}@latest`, { timeout });
    const bins: string[] = step.bins.length > 0 ? step.bins : [pkg.split("/").pop() || pkg];

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      installedBins: [],
    };
  }
}

async function installUvAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const pkg: string | undefined = step.package ?? step.formula ?? undefined;

  if (!pkg) {
    return { success: false, error: "No package specified for uv pip install", installedBins: [] };
  }

  try {
    await execAsync(`uv pip install ${pkg}`, { timeout });
    const bins: string[] = step.bins;

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      installedBins: [],
    };
  }
}

//#endregion Private Functions
