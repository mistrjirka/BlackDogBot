import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { ISkillRequirements, ISkillMissingDeps } from "../shared/types/index.js";
import { DEPENDENCY_CHECK_CACHE_TTL_MS, MAX_DEPENDENCY_CACHE_ENTRIES, MAX_DEPENDENCY_CHECKS_PER_REFRESH } from "../shared/constants.js";

//#region Types

const execAsync = promisify(exec);

interface IAnyBinResult {
  satisfied: boolean;
  complete: boolean;
  found: string | null;
}

interface IDependencyResult {
  satisfied: boolean;
  complete: boolean;
  missing: ISkillMissingDeps;
}

export interface IDependencyCheckBudget {
  remaining: number;
}

//#endregion Types

//#region Data members

interface IBinaryCacheEntry {
  exists: boolean;
  checkedAt: number;
}

const _binaryCache: Map<string, IBinaryCacheEntry> = new Map();

function setBinaryCacheEntry(bin: string, exists: boolean): void {
  if (!_binaryCache.has(bin) && _binaryCache.size >= MAX_DEPENDENCY_CACHE_ENTRIES) {
    const oldestBin: string | undefined = _binaryCache.keys().next().value;
    if (oldestBin !== undefined) {
      _binaryCache.delete(oldestBin);
    }
  }

  _binaryCache.set(bin, { exists, checkedAt: Date.now() });
}

/** Regex that matches safe binary names: alphanumeric, hyphens, underscores, dots */
const SAFE_BINARY_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

/**
 * Validates a binary name is safe for shell interpolation.
 * Rejects names containing shell metacharacters: ; & | $ ` > < ( ) etc.
 */
export function validateBinaryName(name: string): boolean {
  return SAFE_BINARY_NAME_REGEX.test(name);
}

//#endregion Data members

//#region Public Functions

export function clearDependencyCache(): void {
  _binaryCache.clear();
}

export function hasMissingInstallDependencies(missing: ISkillMissingDeps | null | undefined): boolean {
  return (missing?.bins.length ?? 0) > 0 || (missing?.anyBins.length ?? 0) > 0;
}

export function createDependencyCheckBudget(maxChecks: number = MAX_DEPENDENCY_CHECKS_PER_REFRESH): IDependencyCheckBudget {
  return { remaining: Math.max(0, Math.floor(maxChecks)) };
}

export async function checkBinaryAsync(bin: string, budget?: IDependencyCheckBudget): Promise<boolean | null> {
  if (!validateBinaryName(bin)) {
    return false;
  }

  const cached = _binaryCache.get(bin);
  if (cached) {
    const cacheAge: number = Date.now() - cached.checkedAt;
    if (cacheAge >= 0 && cacheAge < DEPENDENCY_CHECK_CACHE_TTL_MS) {
      return cached.exists;
    }
  }

  if (budget && budget.remaining <= 0) {
    return null;
  }
  if (budget) {
    budget.remaining -= 1;
  }

  try {
    const command: string = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
    await execAsync(command, { timeout: 5000 });
    setBinaryCacheEntry(bin, true);

    return true;
  } catch {
    setBinaryCacheEntry(bin, false);

    return false;
  }
}

export async function checkAnyBinAsync(alternatives: string[], budget?: IDependencyCheckBudget): Promise<IAnyBinResult> {
  for (const bin of alternatives) {
    const exists: boolean | null = await checkBinaryAsync(bin, budget);

    if (exists === null) {
      return { satisfied: false, complete: false, found: null };
    }
    if (exists) {
      return { satisfied: true, complete: true, found: bin };
    }
  }

  return { satisfied: false, complete: true, found: null };
}

export function checkEnv(varName: string): boolean {
  return process.env[varName] !== undefined && process.env[varName] !== "";
}

export function checkConfig(configPath: string, config: Record<string, unknown>): boolean {
  const parts: string[] = configPath.split(".");
  let current: unknown = config;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return false;
    }

    if (typeof current !== "object") {
      return false;
    }

    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }

    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === "string") {
    return current.trim().length > 0;
  }
  return current !== undefined && current !== null;
}

export async function checkRequirementsAsync(
  requires: ISkillRequirements | undefined,
  config: Record<string, unknown>,
  budget?: IDependencyCheckBudget,
): Promise<IDependencyResult> {
  if (!requires) {
    return {
      satisfied: true,
      complete: true,
      missing: { bins: [], anyBins: [], env: [], config: [] },
    };
  }

  const missing: ISkillMissingDeps = {
    bins: [],
    anyBins: [],
    env: [],
    config: [],
  };
  let complete = true;

  for (const bin of requires.bins || []) {
    const exists: boolean | null = await checkBinaryAsync(bin, budget);

    if (exists === null) {
      complete = false;
    } else if (!exists) {
      missing.bins.push(bin);
    }
  }

  // anyBins is a single group of alternatives — check as a group, not individually
  if (requires.anyBins && requires.anyBins.length > 0) {
    const result: IAnyBinResult = await checkAnyBinAsync(requires.anyBins, budget);
    if (!result.complete) {
      complete = false;
    } else if (!result.satisfied) {
      missing.anyBins = requires.anyBins;
    }
  }

  for (const envVar of requires.env || []) {
    if (!checkEnv(envVar)) {
      missing.env.push(envVar);
    }
  }

  for (const configPath of requires.config || []) {
    if (!checkConfig(configPath, config)) {
      missing.config.push(configPath);
    }
  }

  const satisfied: boolean = complete &&
    missing.bins.length === 0 &&
    missing.anyBins.length === 0 &&
    missing.env.length === 0 &&
    missing.config.length === 0;

  return { satisfied, complete, missing };
}

//#endregion Public Functions
