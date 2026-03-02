import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { ISkillRequirements, ISkillMissingDeps } from "../shared/types/index.js";

const execAsync = promisify(exec);

interface IAnyBinResult {
  satisfied: boolean;
  found: string | null;
}

interface IDependencyResult {
  satisfied: boolean;
  missing: ISkillMissingDeps;
}

export class DependencyCheckerService {

  private static _instance: DependencyCheckerService | null;
  private _binaryCache: Map<string, boolean>;

  private constructor() {
    this._binaryCache = new Map();
  }

  public static getInstance(): DependencyCheckerService {
    if (!DependencyCheckerService._instance) {
      DependencyCheckerService._instance = new DependencyCheckerService();
    }

    return DependencyCheckerService._instance;
  }

  public clearCache(): void {
    this._binaryCache.clear();
  }

  public async checkBinary(bin: string): Promise<boolean> {
    if (this._binaryCache.has(bin)) {
      return this._binaryCache.get(bin)!;
    }

    try {
      const command = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
      await execAsync(command, { timeout: 5000 });
      this._binaryCache.set(bin, true);

      return true;
    } catch {
      this._binaryCache.set(bin, false);

      return false;
    }
  }

  public async checkAnyBin(alternatives: string[]): Promise<IAnyBinResult> {
    for (const bin of alternatives) {
      const exists = await this.checkBinary(bin);

      if (exists) {
        return { satisfied: true, found: bin };
      }
    }

    return { satisfied: false, found: null };
  }

  public checkEnv(varName: string): boolean {
    return process.env[varName] !== undefined && process.env[varName] !== "";
  }

  public checkConfig(configPath: string, config: Record<string, unknown>): boolean {
    const parts = configPath.split(".");
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

  public async checkRequirements(
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
      const exists = await this.checkBinary(bin);

      if (!exists) {
        missing.bins.push(bin);
      }
    }

    for (const binAlternatives of requires.anyBins || []) {
      const result = await this.checkAnyBin([binAlternatives]);

      if (!result.satisfied) {
        missing.anyBins.push(binAlternatives);
      }
    }

    for (const envVar of requires.env || []) {
      if (!this.checkEnv(envVar)) {
        missing.env.push(envVar);
      }
    }

    if (config) {
      for (const configPath of requires.config || []) {
        if (!this.checkConfig(configPath, config)) {
          missing.config.push(configPath);
        }
      }
    }

    const satisfied =
      missing.bins.length === 0 &&
      missing.anyBins.length === 0 &&
      missing.env.length === 0 &&
      missing.config.length === 0;

    return { satisfied, missing };
  }
}
