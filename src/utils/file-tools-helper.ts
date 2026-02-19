import path from "node:path";
import os from "node:os";

import { getWorkspaceDir } from "./paths.js";

//#region Interfaces

export interface IFileReadTracker {
  markRead(resolvedPath: string): void;
  hasBeenRead(resolvedPath: string): boolean;
}

//#endregion Interfaces

//#region FileReadTracker

export class FileReadTracker implements IFileReadTracker {
  //#region Data members

  private _readPaths: Set<string>;

  //#endregion Data members

  //#region Constructors

  public constructor() {
    this._readPaths = new Set<string>();
  }

  //#endregion Constructors

  //#region Public methods

  public markRead(resolvedPath: string): void {
    this._readPaths.add(resolvedPath);
  }

  public hasBeenRead(resolvedPath: string): boolean {
    return this._readPaths.has(resolvedPath);
  }

  //#endregion Public methods
}

//#endregion FileReadTracker

//#region Public functions

/**
 * Resolves a file path for file tools.
 * - Empty string or just a filename → resolved relative to workspace dir
 * - Paths starting with ~ → expands home directory
 * - Absolute paths → used as-is
 * - Relative paths (with directory separators) → resolved relative to workspace dir
 */
export function resolveFilePath(filePath: string): string {
  const trimmed: string = filePath.trim();

  if (trimmed === "") {
    throw new Error("File path cannot be empty.");
  }

  if (trimmed.startsWith("~")) {
    return trimmed.replace("~", os.homedir());
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  // Relative path — resolve against workspace directory
  return path.join(getWorkspaceDir(), trimmed);
}

//#endregion Public functions
