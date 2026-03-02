import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { ISkillRequirements, ISkillMissingDeps } from "../shared/types/index.js";

//#region Types

const execAsync = promisify(exec);

interface IAnyBinResult {
  satisfied: boolean;
  found: string | null;
}

interface IDependencyResult {
  satisfied: boolean;
  missing: ISkillMissingDeps;
}

//#endregion Types

//#region Data members

const _binaryCache: Map<string, boolean> = new Map();

//#endregion Data members

//#region Public Functions

export function clearDependencyCache(): void {
  _binaryCache.clear();
}

export async function checkBinaryAsync(bin: string): Promise<boolean> {
  if (_binaryCache.has(bin)) {
    return _binaryCache.get(bin)!;
  }

  try {
    const command: string = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
    await execAsync(command, { timeout: 5000 });
    _binaryCache.set(bin, true);

    return true;
  } catch {
    _binaryCache.set(bin, false);

    return false;
  }
}

export async function checkAnyBinAsync(alternatives: string[]): Promise<IAnyBinResult> {
  for (const bin of alternatives) {
    const exists: boolean = await checkBinaryAsync(bin);

    if (exists) {
      return { satisfied: true, found: bin };
    }
  }

  return { satisfied: false, found: null };
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

    current = (current as Record<string, unknown>)[part];
  }

  return current !== undefined && current !== null;
}

export async function checkRequirementsAsync(
  requires: ISkillRequirements | undefined,
  config?: Record<string, unknown>,
): Promise<IDependencyResult> {
  if (!requires) {
    return {
      satisfied: true,
      missing: { bins: [], anyBins: [], env: [], config: [] },
    };
  }

  const missing: ISkillMissingDeps = {
    bins: [],
    anyBins: [],
    env: [],
    config: [],
  };

  for (const bin of requires.bins || []) {
    const exists: boolean = await checkBinaryAsync(bin);

    if (!exists) {
      missing.bins.push(bin);
    }
  }

  for (const binAlternatives of requires.anyBins || []) {
    const result: IAnyBinResult = await checkAnyBinAsync([binAlternatives]);

    if (!result.satisfied) {
      missing.anyBins.push(binAlternatives);
    }
  }

  for (const envVar of requires.env || []) {
    if (!checkEnv(envVar)) {
      missing.env.push(envVar);
    }
  }

  if (config) {
    for (const configPath of requires.config || []) {
      if (!checkConfig(configPath, config)) {
        missing.config.push(configPath);
      }
    }
  }

  const satisfied: boolean =
    missing.bins.length === 0 &&
    missing.anyBins.length === 0 &&
    missing.env.length === 0 &&
    missing.config.length === 0;

  return { satisfied, missing };
}

//#endregion Public Functions
