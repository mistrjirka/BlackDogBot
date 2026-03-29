import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import {
  ensureParentAndWriteFileAsync,
  fileExistsAsync,
  listFilesRecursiveAsync,
  resolvePromptIncludesAsync,
} from "./prompt-service-helpers.js";
import {
  getPromptsDir,
  getPromptFragmentsDir,
  getPromptFilePath,
  getCacheDir,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";

//#region Interfaces

export interface IPromptInfo {
  name: string;
  path: string;
  isModified: boolean;
}

interface IPromptSyncState {
  lastAppliedDefaultsFingerprint: string;
  updatedAt: string;
}

//#endregion Interfaces

//#region Constants

const MAX_INCLUDE_DEPTH: number = 5;
const PROMPT_SYNC_STATE_FILE_NAME: string = "prompt-sync-state.json";

//#endregion Constants

export class PromptService {
  //#region Data members

  private static _instance: PromptService | null;
  private _promptsDir: string;
  private _defaultsDir: string;
  private _initialized: boolean;
  private _promptCache: Map<string, string>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._promptsDir = "";
    this._defaultsDir = "";
    this._initialized = false;
    this._promptCache = new Map<string, string>();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): PromptService {
    if (!PromptService._instance) {
      PromptService._instance = new PromptService();
    }

    return PromptService._instance;
  }

  public async initializeAsync(): Promise<void> {
    this._promptsDir = getPromptsDir();
    this._defaultsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "defaults",
      "prompts",
    );

    await ensureDirectoryExistsAsync(this._promptsDir);
    await ensureDirectoryExistsAsync(getPromptFragmentsDir());
    await ensureDirectoryExistsAsync(getCacheDir());
    await this._copyDefaultsIfNeededAsync();
    await this._syncUpdatedDefaultsAsync();
    await this._initializePromptSyncStateIfMissingAsync();

    this._initialized = true;
  }

  public async getPromptAsync(promptName: string): Promise<string> {
    this._ensureInitialized();

    const cached: string | undefined = this._promptCache.get(promptName);

    if (cached !== undefined) {
      return cached;
    }

    const filePath: string = this._getPromptPath(promptName);

    if (!(await fileExistsAsync(filePath))) {
      throw new Error(`Prompt not found: ${promptName}`);
    }

    const rawContent: string = await fs.readFile(filePath, "utf-8");
    const resolvedContent: string = await resolvePromptIncludesAsync(rawContent, this._promptsDir, MAX_INCLUDE_DEPTH);

    this._promptCache.set(promptName, resolvedContent);

    return resolvedContent;
  }

  public async getPromptRawAsync(promptName: string): Promise<string> {
    this._ensureInitialized();

    const filePath: string = this._getPromptPath(promptName);

    if (!(await fileExistsAsync(filePath))) {
      throw new Error(`Prompt not found: ${promptName}`);
    }

    const content: string = await fs.readFile(filePath, "utf-8");

    return content;
  }

  public async writePromptAsync(promptName: string, content: string): Promise<void> {
    this._ensureInitialized();

    const filePath: string = this._getPromptPath(promptName);
    await ensureParentAndWriteFileAsync(filePath, content);

    this._promptCache.delete(promptName);
  }

  public async appendToPromptAsync(promptName: string, content: string): Promise<void> {
    this._ensureInitialized();

    const filePath: string = this._getPromptPath(promptName);

    if (!(await fileExistsAsync(filePath))) {
      throw new Error(`Prompt not found: ${promptName}`);
    }

    const existingContent: string = await fs.readFile(filePath, "utf-8");
    const newContent: string = existingContent + content;

    await fs.writeFile(filePath, newContent, "utf-8");

    this._promptCache.delete(promptName);
  }

  public async resetPromptAsync(promptName: string): Promise<void> {
    this._ensureInitialized();

    const defaultPath: string = this._getDefaultPath(promptName);

    if (!(await fileExistsAsync(defaultPath))) {
      throw new Error(`No default exists for prompt: ${promptName}`);
    }

    const defaultContent: string = await fs.readFile(defaultPath, "utf-8");
    const targetPath: string = this._getPromptPath(promptName);
    await ensureParentAndWriteFileAsync(targetPath, defaultContent);

    this._promptCache.delete(promptName);
  }

  public async resetAllPromptsAsync(): Promise<void> {
    this._ensureInitialized();

    const defaultFiles: string[] = await listFilesRecursiveAsync(this._defaultsDir);

    for (const defaultFile of defaultFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const targetPath: string = path.join(this._promptsDir, relativePath);
      const content: string = await fs.readFile(defaultFile, "utf-8");

      await ensureParentAndWriteFileAsync(targetPath, content);
    }

    this._promptCache.clear();
    await this._markPromptsSyncedToCurrentDefaultsAsync();
  }

  public async isPromptUpdateRecommendedAsync(): Promise<boolean> {
    this._ensureInitialized();

    const state: IPromptSyncState | null = await this._readPromptSyncStateAsync();
    if (state === null) {
      return false;
    }

    const currentFingerprint: string = await this._computeDefaultsFingerprintAsync();
    return state.lastAppliedDefaultsFingerprint !== currentFingerprint;
  }

  public async listPromptsAsync(): Promise<IPromptInfo[]> {
    this._ensureInitialized();

    const allFiles: string[] = await listFilesRecursiveAsync(this._promptsDir);
    const mdFiles: string[] = allFiles.filter((file: string) => file.endsWith(".md"));
    const promptInfos: IPromptInfo[] = [];

    for (const filePath of mdFiles) {
      const relativePath: string = path.relative(this._promptsDir, filePath);
      const name: string = relativePath.replace(/\.md$/, "");
      const defaultPath: string = this._getDefaultPath(name);
      let isModified: boolean = false;

      if (await fileExistsAsync(defaultPath)) {
        const userContent: string = await fs.readFile(filePath, "utf-8");
        const defaultContent: string = await fs.readFile(defaultPath, "utf-8");

        isModified = userContent !== defaultContent;
      }

      promptInfos.push({
        name,
        path: filePath,
        isModified,
      });
    }

    return promptInfos;
  }

  public clearCache(): void {
    this._promptCache.clear();
  }

  public async reloadPromptsFromDiskAsync(): Promise<void> {
    this._ensureInitialized();
    this._promptCache.clear();
  }

  public async refreshPromptCacheAsync(): Promise<void> {
    await this.reloadPromptsFromDiskAsync();
  }

  //#endregion Public methods

  //#region Private methods

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error("PromptService not initialized");
    }
  }

  private async _copyDefaultsIfNeededAsync(): Promise<void> {
    const defaultFiles: string[] = await listFilesRecursiveAsync(this._defaultsDir);
    const mdFiles: string[] = defaultFiles.filter((file: string) => file.endsWith(".md"));

    for (const defaultFile of mdFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const targetPath: string = path.join(this._promptsDir, relativePath);

      if (!(await fileExistsAsync(targetPath))) {
        const content: string = await fs.readFile(defaultFile, "utf-8");

        await ensureParentAndWriteFileAsync(targetPath, content);
      }
    }
  }

  private async _syncUpdatedDefaultsAsync(): Promise<void> {
    const defaultFiles: string[] = await listFilesRecursiveAsync(this._defaultsDir);
    const mdFiles: string[] = defaultFiles.filter((file: string) => file.endsWith(".md"));

    for (const defaultFile of mdFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const targetPath: string = path.join(this._promptsDir, relativePath);
      const defaultContent: string = await fs.readFile(defaultFile, "utf-8");

      await ensureParentAndWriteFileAsync(targetPath, defaultContent);
    }

    await this._markPromptsSyncedToCurrentDefaultsAsync();
  }

  private async _initializePromptSyncStateIfMissingAsync(): Promise<void> {
    const existingState: IPromptSyncState | null = await this._readPromptSyncStateAsync();
    if (existingState !== null) {
      return;
    }

    await this._markPromptsSyncedToCurrentDefaultsAsync();
  }

  private async _markPromptsSyncedToCurrentDefaultsAsync(): Promise<void> {
    const fingerprint: string = await this._computeDefaultsFingerprintAsync();
    const state: IPromptSyncState = {
      lastAppliedDefaultsFingerprint: fingerprint,
      updatedAt: new Date().toISOString(),
    };

    const statePath: string = this._getPromptSyncStatePath();
    await ensureParentAndWriteFileAsync(statePath, JSON.stringify(state, null, 2));
  }

  private async _readPromptSyncStateAsync(): Promise<IPromptSyncState | null> {
    const statePath: string = this._getPromptSyncStatePath();
    if (!(await fileExistsAsync(statePath))) {
      return null;
    }

    try {
      const rawState: string = await fs.readFile(statePath, "utf-8");
      const parsedState: unknown = JSON.parse(rawState);
      if (typeof parsedState !== "object" || parsedState === null) {
        return null;
      }

      const stateObject: Record<string, unknown> = parsedState as Record<string, unknown>;
      const fingerprint: unknown = stateObject.lastAppliedDefaultsFingerprint;
      const updatedAt: unknown = stateObject.updatedAt;

      if (typeof fingerprint !== "string" || fingerprint.length === 0) {
        return null;
      }

      if (typeof updatedAt !== "string" || updatedAt.length === 0) {
        return null;
      }

      return {
        lastAppliedDefaultsFingerprint: fingerprint,
        updatedAt,
      };
    } catch {
      return null;
    }
  }

  private async _computeDefaultsFingerprintAsync(): Promise<string> {
    const defaultFiles: string[] = await listFilesRecursiveAsync(this._defaultsDir);
    const sortedFiles: string[] = defaultFiles
      .filter((filePath: string): boolean => filePath.endsWith(".md"))
      .sort((a: string, b: string): number => a.localeCompare(b));

    const hash = crypto.createHash("sha256");

    for (const filePath of sortedFiles) {
      const relativePath: string = path.relative(this._defaultsDir, filePath);
      const content: string = await fs.readFile(filePath, "utf-8");
      hash.update(relativePath, "utf-8");
      hash.update("\n", "utf-8");
      hash.update(content, "utf-8");
      hash.update("\n---\n", "utf-8");
    }

    return hash.digest("hex");
  }

  private _getPromptSyncStatePath(): string {
    return path.join(getCacheDir(), PROMPT_SYNC_STATE_FILE_NAME);
  }

  private _getPromptPath(promptName: string): string {
    if (promptName.includes("/")) {
      return path.join(this._promptsDir, promptName + ".md");
    }

    return getPromptFilePath(promptName);
  }

  private _getDefaultPath(promptName: string): string {
    if (promptName.includes("/")) {
      return path.join(this._defaultsDir, promptName + ".md");
    }

    return path.join(this._defaultsDir, `${promptName}.md`);
  }

  //#endregion Private methods
}
