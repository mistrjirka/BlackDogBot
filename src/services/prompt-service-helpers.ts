import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";

import { INCLUDE_DIRECTIVE_REGEX } from "../shared/constants.js";
import { ensureDirectoryExistsAsync } from "../utils/paths.js";

//#region Public Functions

export async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);

    return true;
  } catch {
    return false;
  }
}

export async function listFilesRecursiveAsync(dir: string): Promise<string[]> {
  const entries: Dirent[] = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath: string = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles: string[] = await listFilesRecursiveAsync(fullPath);
      files.push(...subFiles);
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export async function resolvePromptIncludesAsync(
  content: string,
  promptsDir: string,
  maxIncludeDepth: number,
  depth: number = 0,
): Promise<string> {
  if (depth >= maxIncludeDepth) {
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

    const includePath: string = path.join(promptsDir, filename);

    if (!(await fileExistsAsync(includePath))) {
      throw new Error(`Include file not found: ${filename}`);
    }

    const includeContent: string = await fs.readFile(includePath, "utf-8");
    const resolvedInclude: string = await resolvePromptIncludesAsync(
      includeContent,
      promptsDir,
      maxIncludeDepth,
      depth + 1,
    );

    result += resolvedInclude;
    lastIndex = matchIndex + fullMatch.length;
  }

  result += content.slice(lastIndex);

  return result;
}

export async function ensureParentAndWriteFileAsync(filePath: string, content: string): Promise<void> {
  const parentDir: string = path.dirname(filePath);
  await ensureDirectoryExistsAsync(parentDir);
  await fs.writeFile(filePath, content, "utf-8");
}

//#endregion Public Functions
