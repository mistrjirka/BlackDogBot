import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INCLUDE_DIRECTIVE_REGEX } from "../shared/constants.js";
import {
  getPromptsDir,
  getPromptFragmentsDir,
  getPromptFilePath,
  ensureDirectoryExistsAsync,
} from "../utils/paths.js";

//#region Interfaces

export interface IPromptInfo {
  name: string;
  path: string;
  isModified: boolean;
}

//#endregion Interfaces

//#region Constants

const MAX_INCLUDE_DEPTH: number = 5;

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
    await this._copyDefaultsIfNeededAsync();

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

  //#endregion Private methods
}
