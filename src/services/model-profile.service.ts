import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { ensureDirectoryExistsAsync, getModelProfilesDir } from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";

//#region Types

export type ModelProfileOperation =
  | "agent_primary"
  | "summarization"
  | "schema_extraction"
  | "cron_history"
  | "job_execution";

export interface IRequestBehaviorProfile {
  reasoningFormat?: string;
  parallelToolCalls?: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
}

export interface IModelProfile {
  name: string;
  description?: string;
  defaults?: IRequestBehaviorProfile;
  operations?: Partial<Record<ModelProfileOperation, IRequestBehaviorProfile>>;
}

//#endregion Types

//#region Constants

const _YamlExtensions: string[] = [".yaml", ".yml"];
const _DefaultQwen35ProfileName: string = "qwen3_5";

//#endregion Constants

export class ModelProfileService {
  //#region Data members

  private static _instance: ModelProfileService | null;
  private _initialized: boolean;
  private _defaultsDir: string;
  private _profilesDir: string;
  private _profiles: Map<string, IModelProfile>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._initialized = false;
    this._defaultsDir = "";
    this._profilesDir = "";
    this._profiles = new Map<string, IModelProfile>();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): ModelProfileService {
    if (!ModelProfileService._instance) {
      ModelProfileService._instance = new ModelProfileService();
    }

    return ModelProfileService._instance;
  }

  public async initializeAsync(profilesDirOverride?: string): Promise<void> {
    this._defaultsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "defaults",
      "model-profiles",
    );

    const configuredDir: string | undefined = profilesDirOverride?.trim();
    this._profilesDir = configuredDir && configuredDir.length > 0
      ? this._expandHome(configuredDir)
      : getModelProfilesDir();

    await ensureDirectoryExistsAsync(this._profilesDir);
    await this._copyDefaultsIfNeededAsync();

    const builtInProfiles: Map<string, IModelProfile> = await this._loadProfilesFromDirectoryAsync(this._defaultsDir);
    const userProfiles: Map<string, IModelProfile> = await this._loadProfilesFromDirectoryAsync(this._profilesDir);

    this._profiles = new Map<string, IModelProfile>(builtInProfiles);

    for (const [name, userProfile] of userProfiles) {
      const existing: IModelProfile | undefined = this._profiles.get(name);
      if (!existing) {
        this._profiles.set(name, userProfile);
        continue;
      }

      this._profiles.set(name, this._mergeProfiles(existing, userProfile));
    }

    this._ensureFallbackProfiles(builtInProfiles);

    this._initialized = true;
  }

  public hasProfile(profileName: string): boolean {
    this._ensureInitialized();

    return this._profiles.has(profileName);
  }

  public resolveRequestBehavior(
    profileName: string,
    operation: ModelProfileOperation,
  ): IRequestBehaviorProfile | null {
    this._ensureInitialized();

    const profile: IModelProfile | undefined = this._profiles.get(profileName);
    if (!profile) {
      return null;
    }

    const defaults: IRequestBehaviorProfile = profile.defaults ?? {};
    const operationOverride: IRequestBehaviorProfile = profile.operations?.[operation] ?? {};

    return this._mergeRequestBehavior(defaults, operationOverride);
  }

  public getProfilesDirectory(): string {
    this._ensureInitialized();

    return this._profilesDir;
  }

  //#endregion Public methods

  //#region Private methods

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error("ModelProfileService not initialized");
    }
  }

  private _expandHome(value: string): string {
    if (value === "~") {
      return os.homedir();
    }

    if (value.startsWith("~/")) {
      return path.join(os.homedir(), value.slice(2));
    }

    return value;
  }

  private async _copyDefaultsIfNeededAsync(): Promise<void> {
    const defaultFiles: string[] = await this._listYamlFilesRecursiveAsync(this._defaultsDir);

    for (const defaultFile of defaultFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const targetPath: string = path.join(this._profilesDir, relativePath);

      try {
        await fs.access(targetPath);
        continue;
      } catch {
        const parentDir: string = path.dirname(targetPath);
        await ensureDirectoryExistsAsync(parentDir);
        const content: string = await fs.readFile(defaultFile, "utf-8");
        await fs.writeFile(targetPath, content, "utf-8");
      }
    }
  }

  private async _loadProfilesFromDirectoryAsync(directoryPath: string): Promise<Map<string, IModelProfile>> {
    const profiles: Map<string, IModelProfile> = new Map<string, IModelProfile>();
    const files: string[] = await this._listYamlFilesRecursiveAsync(directoryPath);

    for (const filePath of files) {
      try {
        const content: string = await fs.readFile(filePath, "utf-8");
        const parsedUnknown: unknown = parseYaml(content);
        const fallbackName: string = path.basename(filePath, path.extname(filePath));
        const profile: IModelProfile | null = this._parseProfile(parsedUnknown, fallbackName);

        if (profile) {
          profiles.set(profile.name, profile);
        }
      } catch (error: unknown) {
        const logger: LoggerService = LoggerService.getInstance();
        logger.warn("Failed to load model profile YAML", {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return profiles;
  }

  private async _listYamlFilesRecursiveAsync(directoryPath: string): Promise<string[]> {
    const results: string[] = [];

    let entries: Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath: string = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        const nested: string[] = await this._listYamlFilesRecursiveAsync(fullPath);
        results.push(...nested);
        continue;
      }

      if (entry.isFile()) {
        const extension: string = path.extname(entry.name).toLowerCase();
        if (_YamlExtensions.includes(extension)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }

  private _parseProfile(raw: unknown, fallbackName: string): IModelProfile | null {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }

    const profileObj: Record<string, unknown> = raw as Record<string, unknown>;
    const nameRaw: unknown = profileObj.name;
    const name: string = typeof nameRaw === "string" && nameRaw.trim().length > 0
      ? nameRaw.trim()
      : fallbackName;

    const descriptionRaw: unknown = profileObj.description;
    const description: string | undefined = typeof descriptionRaw === "string" ? descriptionRaw : undefined;

    const defaults: IRequestBehaviorProfile | undefined = this._parseRequestBehavior(profileObj.defaults);
    const operationsRaw: unknown = profileObj.operations;

    let operations: Partial<Record<ModelProfileOperation, IRequestBehaviorProfile>> | undefined;
    if (typeof operationsRaw === "object" && operationsRaw !== null) {
      const operationsObj: Record<string, unknown> = operationsRaw as Record<string, unknown>;
      const parsedOperations: Partial<Record<ModelProfileOperation, IRequestBehaviorProfile>> = {};

      for (const operation of [
        "agent_primary",
        "summarization",
        "schema_extraction",
        "cron_history",
        "job_execution",
      ] as const) {
        const parsedBehavior: IRequestBehaviorProfile | undefined = this._parseRequestBehavior(operationsObj[operation]);
        if (parsedBehavior) {
          parsedOperations[operation] = parsedBehavior;
        }
      }

      if (Object.keys(parsedOperations).length > 0) {
        operations = parsedOperations;
      }
    }

    return {
      name,
      description,
      ...(defaults ? { defaults } : {}),
      ...(operations ? { operations } : {}),
    };
  }

  private _parseRequestBehavior(value: unknown): IRequestBehaviorProfile | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const obj: Record<string, unknown> = value as Record<string, unknown>;
    const reasoningFormatRaw: unknown = obj.reasoningFormat;
    const parallelToolCallsRaw: unknown = obj.parallelToolCalls;
    const chatTemplateKwargsRaw: unknown = obj.chatTemplateKwargs;

    const behavior: IRequestBehaviorProfile = {};

    if (typeof reasoningFormatRaw === "string" && reasoningFormatRaw.trim().length > 0) {
      behavior.reasoningFormat = reasoningFormatRaw.trim();
    }

    if (typeof parallelToolCallsRaw === "boolean") {
      behavior.parallelToolCalls = parallelToolCallsRaw;
    }

    if (typeof chatTemplateKwargsRaw === "object" && chatTemplateKwargsRaw !== null && !Array.isArray(chatTemplateKwargsRaw)) {
      behavior.chatTemplateKwargs = chatTemplateKwargsRaw as Record<string, unknown>;
    }

    if (Object.keys(behavior).length === 0) {
      return undefined;
    }

    return behavior;
  }

  private _mergeProfiles(baseProfile: IModelProfile, overrideProfile: IModelProfile): IModelProfile {
    const mergedOperations: Partial<Record<ModelProfileOperation, IRequestBehaviorProfile>> = {
      ...(baseProfile.operations ?? {}),
    };

    if (overrideProfile.operations) {
      for (const operation of Object.keys(overrideProfile.operations) as ModelProfileOperation[]) {
        const baseBehavior: IRequestBehaviorProfile = mergedOperations[operation] ?? {};
        const overrideBehavior: IRequestBehaviorProfile = overrideProfile.operations[operation] ?? {};
        mergedOperations[operation] = this._mergeRequestBehavior(baseBehavior, overrideBehavior);
      }
    }

    return {
      name: baseProfile.name,
      description: overrideProfile.description ?? baseProfile.description,
      defaults: this._mergeRequestBehavior(baseProfile.defaults ?? {}, overrideProfile.defaults ?? {}),
      operations: mergedOperations,
    };
  }

  private _mergeRequestBehavior(
    baseBehavior: IRequestBehaviorProfile,
    overrideBehavior: IRequestBehaviorProfile,
  ): IRequestBehaviorProfile {
    const merged: IRequestBehaviorProfile = {
      ...baseBehavior,
      ...overrideBehavior,
      chatTemplateKwargs: {
        ...(baseBehavior.chatTemplateKwargs ?? {}),
        ...(overrideBehavior.chatTemplateKwargs ?? {}),
      },
    };

    if (Object.keys(merged.chatTemplateKwargs ?? {}).length === 0) {
      delete merged.chatTemplateKwargs;
    }

    return merged;
  }

  private _ensureFallbackProfiles(builtInProfiles: Map<string, IModelProfile>): void {
    if (!this._profiles.has(_DefaultQwen35ProfileName)) {
      const fallback: IModelProfile = {
        name: _DefaultQwen35ProfileName,
        description: "Fallback built-in profile for Qwen3.5 request-level thinking control.",
        defaults: {
          reasoningFormat: "none",
          parallelToolCalls: true,
          chatTemplateKwargs: { enable_thinking: true },
        },
        operations: {
          agent_primary: { chatTemplateKwargs: { enable_thinking: true } },
          summarization: { chatTemplateKwargs: { enable_thinking: false } },
          schema_extraction: { chatTemplateKwargs: { enable_thinking: false } },
          cron_history: { chatTemplateKwargs: { enable_thinking: false } },
          job_execution: { chatTemplateKwargs: { enable_thinking: true } },
        },
      };
      this._profiles.set(_DefaultQwen35ProfileName, fallback);
      builtInProfiles.set(_DefaultQwen35ProfileName, fallback);
    }
  }

  //#endregion Private methods
}
