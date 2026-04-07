import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

import { INCLUDE_DIRECTIVE_REGEX } from "../shared/constants.js";
import {
  getPromptsDir,
  getPromptFragmentsDir,
  getPromptFilePath,
  getCacheDir,
  getOldDatumBackupDir,
  getCommitHashPath,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";

//#region Interfaces

export interface IPromptInfo {
  name: string;
  path: string;
  isModified: boolean;
}

interface IPromptSyncState {
  lastAppliedDefaultsFingerprint: string;
  updatedAt: string;
  commitHash: string | null;
}

//#endregion Interfaces

//#region Constants

const MAX_INCLUDE_DEPTH: number = 5;
const PROMPT_SYNC_STATE_FILE_NAME: string = "prompt-sync-state.json";
const MAX_BACKUP_VERSIONS: number = 2;
const BACKUP_FILENAME_PREFIX: string = "._saved_at_";

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
    await this._initializePromptSyncStateIfMissingAsync();
    await this._backupUserPromptsIfGitHashChangedAsync();

    this._initialized = true;
  }

  public async getPromptAsync(promptName: string): Promise<string> {
    this._ensureInitialized();

    const cached: string | undefined = this._promptCache.get(promptName);

    if (cached !== undefined) {
      return cached;
    }

    const filePath: string = this._getPromptPath(promptName);

    if (!(await this._fileExistsAsync(filePath))) {
      throw new Error(`Prompt not found: ${promptName}`);
    }

    const rawContent: string = await fs.readFile(filePath, "utf-8");
    const resolvedContent: string = await this._resolveIncludesAsync(rawContent);

    this._promptCache.set(promptName, resolvedContent);

    return resolvedContent;
  }

  public async getPromptRawAsync(promptName: string): Promise<string> {
    this._ensureInitialized();

    const filePath: string = this._getPromptPath(promptName);

    if (!(await this._fileExistsAsync(filePath))) {
      throw new Error(`Prompt not found: ${promptName}`);
    }

    const content: string = await fs.readFile(filePath, "utf-8");

    return content;
  }

  public async writePromptAsync(promptName: string, content: string): Promise<void> {
    this._ensureInitialized();

    const filePath: string = this._getPromptPath(promptName);
    const parentDir: string = path.dirname(filePath);

    await ensureDirectoryExistsAsync(parentDir);
    await fs.writeFile(filePath, content, "utf-8");

    this._promptCache.delete(promptName);
  }

  public async appendToPromptAsync(promptName: string, content: string): Promise<void> {
    this._ensureInitialized();

    const filePath: string = this._getPromptPath(promptName);

    if (!(await this._fileExistsAsync(filePath))) {
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

    if (!(await this._fileExistsAsync(defaultPath))) {
      throw new Error(`No default exists for prompt: ${promptName}`);
    }

    const defaultContent: string = await fs.readFile(defaultPath, "utf-8");
    const targetPath: string = this._getPromptPath(promptName);
    const parentDir: string = path.dirname(targetPath);

    await ensureDirectoryExistsAsync(parentDir);
    await fs.writeFile(targetPath, defaultContent, "utf-8");

    this._promptCache.delete(promptName);
  }

  public async resetAllPromptsAsync(): Promise<void> {
    this._ensureInitialized();

    const defaultFiles: string[] = await this._listFilesRecursiveAsync(this._defaultsDir);

    for (const defaultFile of defaultFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const targetPath: string = path.join(this._promptsDir, relativePath);
      const parentDir: string = path.dirname(targetPath);

      await ensureDirectoryExistsAsync(parentDir);

      const content: string = await fs.readFile(defaultFile, "utf-8");

      await fs.writeFile(targetPath, content, "utf-8");
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

    const allFiles: string[] = await this._listFilesRecursiveAsync(this._promptsDir);
    const mdFiles: string[] = allFiles.filter((file: string) => file.endsWith(".md"));
    const promptInfos: IPromptInfo[] = [];

    for (const filePath of mdFiles) {
      const relativePath: string = path.relative(this._promptsDir, filePath);
      const name: string = relativePath.replace(/\.md$/, "");
      const defaultPath: string = this._getDefaultPath(name);
      let isModified: boolean = false;

      if (await this._fileExistsAsync(defaultPath)) {
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
    const defaultFiles: string[] = await this._listFilesRecursiveAsync(this._defaultsDir);
    const mdFiles: string[] = defaultFiles.filter((file: string) => file.endsWith(".md"));

    for (const defaultFile of mdFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const targetPath: string = path.join(this._promptsDir, relativePath);

      if (!(await this._fileExistsAsync(targetPath))) {
        const parentDir: string = path.dirname(targetPath);

        await ensureDirectoryExistsAsync(parentDir);

        const content: string = await fs.readFile(defaultFile, "utf-8");

        await fs.writeFile(targetPath, content, "utf-8");
      }
    }
  }

  private async _resolveIncludesAsync(content: string, depth: number = 0): Promise<string> {
    if (depth >= MAX_INCLUDE_DEPTH) {
      return content;
    }

    const matches: RegExpStringIterator<RegExpExecArray> = content.matchAll(INCLUDE_DIRECTIVE_REGEX);
    let result: string = "";
    let lastIndex: number = 0;

    for (const match of matches) {
      const fullMatch: string = match[0];
      const filename: string = match[1];
      const matchIndex: number = match.index;

      result += content.slice(lastIndex, matchIndex);

      const includePath: string = path.join(this._promptsDir, filename);

      if (!(await this._fileExistsAsync(includePath))) {
        throw new Error(`Include file not found: ${filename}`);
      }

      const includeContent: string = await fs.readFile(includePath, "utf-8");
      const resolvedInclude: string = await this._resolveIncludesAsync(includeContent, depth + 1);

      result += resolvedInclude;
      lastIndex = matchIndex + fullMatch.length;
    }

    result += content.slice(lastIndex);

    return result;
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
    const commitHash: string = await this._getCurrentGitCommitHashAsync();
    const state: IPromptSyncState = {
      lastAppliedDefaultsFingerprint: fingerprint,
      updatedAt: new Date().toISOString(),
      commitHash: commitHash.length > 0 ? commitHash : null,
    };

    const statePath: string = this._getPromptSyncStatePath();
    const parentDir: string = path.dirname(statePath);
    await ensureDirectoryExistsAsync(parentDir);
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  private async _readPromptSyncStateAsync(): Promise<IPromptSyncState | null> {
    const statePath: string = this._getPromptSyncStatePath();
    if (!(await this._fileExistsAsync(statePath))) {
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
      const commitHash: unknown = stateObject.commitHash;

      if (typeof fingerprint !== "string" || fingerprint.length === 0) {
        return null;
      }

      if (typeof updatedAt !== "string" || updatedAt.length === 0) {
        return null;
      }

      return {
        lastAppliedDefaultsFingerprint: fingerprint,
        updatedAt,
        commitHash: typeof commitHash === "string" && commitHash.length > 0 ? commitHash : null,
      };
    } catch {
      return null;
    }
  }

  private async _computeDefaultsFingerprintAsync(): Promise<string> {
    const defaultFiles: string[] = await this._listFilesRecursiveAsync(this._defaultsDir);
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

  private async _fileExistsAsync(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);

      return true;
    } catch {
      return false;
    }
  }

  private async _listFilesRecursiveAsync(dir: string): Promise<string[]> {
    const entries: Dirent[] = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath: string = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles: string[] = await this._listFilesRecursiveAsync(fullPath);

        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }

  private async _getCurrentGitCommitHashAsync(): Promise<string> {
    try {
      const hash: string = execSync("git rev-parse HEAD", { cwd: process.cwd() })
        .toString()
        .trim();
      return hash;
    } catch (error) {
      LoggerService.getInstance().warn("Failed to get git commit hash", { error });
      return "";
    }
  }

  private async _readStoredCommitHashAsync(): Promise<string | null> {
    const hashPath: string = getCommitHashPath();
    if (!(await this._fileExistsAsync(hashPath))) {
      return null;
    }

    try {
      const hash: string = (await fs.readFile(hashPath, "utf-8")).trim();
      return hash.length > 0 ? hash : null;
    } catch {
      return null;
    }
  }

  private async _writeStoredCommitHashAsync(hash: string): Promise<void> {
    const hashPath: string = getCommitHashPath();
    const parentDir: string = path.dirname(hashPath);
    await ensureDirectoryExistsAsync(parentDir);
    await fs.writeFile(hashPath, hash, "utf-8");
  }

  private async _backupUserPromptsIfGitHashChangedAsync(): Promise<void> {
    const currentHash: string = await this._getCurrentGitCommitHashAsync();
    if (currentHash.length === 0) {
      return;
    }

    const storedHash: string | null = await this._readStoredCommitHashAsync();
    if (storedHash === currentHash) {
      return;
    }

    const backupDir: string = getOldDatumBackupDir();
    await ensureDirectoryExistsAsync(backupDir);

    const defaultFiles: string[] = await this._listFilesRecursiveAsync(this._defaultsDir);
    const defaultMdFiles: string[] = defaultFiles.filter((file: string) => file.endsWith(".md"));
    const timestamp: string = new Date().toISOString().replace(/[:.]/g, "-");

    for (const defaultFile of defaultMdFiles) {
      const relativePath: string = path.relative(this._defaultsDir, defaultFile);
      const userPromptPath: string = path.join(this._promptsDir, relativePath);

      if (!(await this._fileExistsAsync(userPromptPath))) {
        continue;
      }

      const userContent: string = await fs.readFile(userPromptPath, "utf-8");
      const defaultContent: string = await fs.readFile(defaultFile, "utf-8");

      if (userContent === defaultContent) {
        continue;
      }

      const backupFilename: string = this._getBackupFilename(relativePath, timestamp);
      const backupPath: string = path.join(backupDir, backupFilename);

      await fs.writeFile(backupPath, userContent, "utf-8");
      LoggerService.getInstance().info("Backed up user prompt", { path: backupPath });
    }

    await this._writeStoredCommitHashAsync(currentHash);
    await this._pruneOldBackupsAsync();
  }

  private _getBackupFilename(originalPath: string, timestamp: string): string {
    const basename: string = path.basename(originalPath);
    return `${BACKUP_FILENAME_PREFIX}${timestamp}_${basename}`;
  }

  private async _pruneOldBackupsAsync(): Promise<void> {
    const backupDir: string = getOldDatumBackupDir();
    if (!(await this._fileExistsAsync(backupDir))) {
      return;
    }

    const files: string[] = await this._listFilesRecursiveAsync(backupDir);
    const backupFiles: string[] = files.filter((f: string) => path.basename(f).startsWith(BACKUP_FILENAME_PREFIX));

    const fileGroups: Map<string, string[]> = new Map();
    for (const filePath of backupFiles) {
      const basename: string = path.basename(filePath);
      const match: RegExpMatchArray | null = basename.match(/^_\.saved_at_[^_]+_(.+)$/);
      if (!match) {
        continue;
      }
      const originalName: string = match[1];
      if (!fileGroups.has(originalName)) {
        fileGroups.set(originalName, []);
      }
      fileGroups.get(originalName)!.push(filePath);
    }

    for (const [, groupFiles] of fileGroups) {
      if (groupFiles.length <= MAX_BACKUP_VERSIONS) {
        continue;
      }

      const sortedFiles: string[] = groupFiles.sort((a: string, b: string) => {
        const aMatch: RegExpMatchArray | null = path.basename(a).match(/^_\.saved_at_(.+)_/);
        const bMatch: RegExpMatchArray | null = path.basename(b).match(/^_\.saved_at_(.+)_/);
        if (!aMatch || !bMatch) return 0;
        return bMatch[1].localeCompare(aMatch[1]);
      });

      const filesToDelete: string[] = sortedFiles.slice(MAX_BACKUP_VERSIONS);
      for (const filePath of filesToDelete) {
        await fs.unlink(filePath);
        LoggerService.getInstance().info("Pruned old backup", { path: filePath });
      }
    }
  }

  //#endregion Private methods
}
