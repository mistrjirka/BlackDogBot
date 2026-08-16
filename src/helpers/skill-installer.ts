import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { ISkillInstallStep } from "../shared/types/index.js";
import { DEFAULT_ALLOWED_INSTALL_KINDS, DEFAULT_SKILL_INSTALL_TIMEOUT_MS, type AllowedInstallKind } from "../shared/constants.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { clearDependencyCache, checkBinaryAsync } from "./dependency-checker.js";
import { sanitizeSetupError } from "./skill-state.js";

//#region Types

const execAsync = promisify(exec);

/** Regex that matches registry/package identifiers before path-segment checks. */
const SAFE_PACKAGE_NAME_REGEX = /^(?!-)[a-zA-Z0-9_@./=~^+-]+$/;

/**
 * Validates a package name is safe for shell interpolation.
 * Rejects names containing shell metacharacters: ; & | $ ` > < ( ) etc.
 * Safe version-specifier characters (=, ~, ^, +) remain supported.
 */
export function validatePackageName(name: string): boolean {
  if (!SAFE_PACKAGE_NAME_REGEX.test(name) || name.startsWith("/") || name.startsWith("~")) {
    return false;
  }

  return !name.split("/").some((segment) => segment === "." || segment === "..");
}


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


const MANUAL_INSTALL_KINDS: AllowedInstallKind[] = ["pacman", "apt", "download"];

export function isManualInstallStep(
  step: ISkillInstallStep,
  allowedKinds: AllowedInstallKind[] = DEFAULT_ALLOWED_INSTALL_KINDS,
): boolean {
  return !allowedKinds.includes(step.kind) || MANUAL_INSTALL_KINDS.includes(step.kind);
}

//#endregion Constants

//#region Public Functions

export async function executeSkillInstallStepsAsync(
  steps: ISkillInstallStep[],
  allowedKinds: AllowedInstallKind[] = DEFAULT_ALLOWED_INSTALL_KINDS,
  timeout: number = DEFAULT_SKILL_INSTALL_TIMEOUT_MS,
): Promise<IInstallResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const result: IInstallResult = {
    success: true,
    installed: [],
    manualStepsRequired: [],
    error: null,
  };

  for (const step of steps) {
    if (isManualInstallStep(step, allowedKinds)) {
      const manualInstruction: string = getSkillManualInstructions(step);
      result.manualStepsRequired.push(manualInstruction);
      logger.info(`Install step "${sanitizeSetupError(step.id)}" requires manual action (${step.kind})`);

      continue;
    }

    logger.info(`Executing install step: ${sanitizeSetupError(step.id)} (${step.kind})`);

    try {
      const stepResult: IInstallStepResult = await executeInstallStepAsync(step, timeout);

      if (stepResult.success) {
        result.installed.push(...stepResult.installedBins);
        logger.info(`Install step "${sanitizeSetupError(step.id)}" completed successfully`);
      } else {
        result.success = false;
        result.error = `Step "${sanitizeSetupError(step.id)}" failed: ${stepResult.error}`;

        break;
      }
    } catch (err) {
      result.success = false;
      result.error = `Step "${sanitizeSetupError(step.id)}" threw error: ${extractErrorMessage(err)}`;

      break;
    }
  }

  clearDependencyCache();

  if (result.success) {
    for (const bin of result.installed) {
      const exists: boolean | null = await checkBinaryAsync(bin);

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
    case "pacman":
    case "apt": {
      const formula: string = step.formula ?? step.package ?? step.id;
      if (!validatePackageName(formula) || formula.endsWith(".rb")) {
        return `${label}: Manual installation required; inspect the package name before running a command`;
      }
      const command: string = step.kind === "pacman"
        ? `sudo pacman -S ${formula}`
        : `sudo apt install -y ${formula}`;

      return `${label}: \`${command}\``;
    }
    case "download":
      return `${label}: Download and install manually (see skill documentation)`;
    default:
      return `${label}: Manual installation required`;
  }
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

  if (!validatePackageName(formula) || formula.endsWith(".rb")) {
    return { success: false, error: `Invalid package name "${formula}": contains unsafe package or path syntax`, installedBins: [] };
  }

  try {
    await execAsync(`brew install ${formula}`, { timeout });
    const bins: string[] = step.bins;

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: extractErrorMessage(err),
      installedBins: [],
    };
  }
}

async function installNodeAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const pkg: string | undefined = step.package ?? step.formula ?? undefined;

  if (!pkg) {
    return { success: false, error: "No package specified for npm install", installedBins: [] };
  }

  if (!validatePackageName(pkg)) {
    return { success: false, error: `Invalid package name "${pkg}": contains unsafe package or path syntax`, installedBins: [] };
  }

  try {
    await execAsync(`npm install -g ${pkg}`, { timeout });
    const bins: string[] = step.bins;

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: extractErrorMessage(err),
      installedBins: [],
    };
  }
}

async function installGoAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const pkg: string | undefined = step.package ?? step.formula ?? undefined;

  if (!pkg) {
    return { success: false, error: "No package specified for go install", installedBins: [] };
  }

  if (!validatePackageName(pkg)) {
    return { success: false, error: `Invalid package name "${pkg}": contains unsafe package or path syntax`, installedBins: [] };
  }

  try {
    await execAsync(`go install ${pkg}@latest`, { timeout });
    const bins: string[] = step.bins;

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: extractErrorMessage(err),
      installedBins: [],
    };
  }
}

async function installUvAsync(step: ISkillInstallStep, timeout: number): Promise<IInstallStepResult> {
  const pkg: string | undefined = step.package ?? step.formula ?? undefined;

  if (!pkg) {
    return { success: false, error: "No package specified for uv pip install", installedBins: [] };
  }

  if (!validatePackageName(pkg)) {
    return { success: false, error: `Invalid package name "${pkg}": contains unsafe package or path syntax`, installedBins: [] };
  }

  try {
    await execAsync(`uv pip install ${pkg}`, { timeout });
    const bins: string[] = step.bins;

    return { success: true, error: null, installedBins: bins };
  } catch (err) {
    return {
      success: false,
      error: extractErrorMessage(err),
      installedBins: [],
    };
  }
}

//#endregion Private Functions
