import path from "node:path";

import { LoggerService } from "../services/logger.service.js";
import { resolveFilePath } from "./file-tools-helper.js";
import { ensureDirectoryExistsAsync } from "./paths.js";

export type FileOperationResult<TValue> =
  | {
    success: true;
    resolvedPath: string;
    value: TValue;
  }
  | {
    success: false;
    errorMessage: string;
  };

export async function runFileOperationAsync<TValue>(args: {
  logger: LoggerService;
  filePath: string;
  onErrorLogMessage: string;
  ensureParentDirectory?: boolean;
  runAsync: (resolvedPath: string) => Promise<TValue>;
}): Promise<FileOperationResult<TValue>> {
  try {
    const resolvedPath: string = resolveFilePath(args.filePath);

    if (args.ensureParentDirectory ?? true) {
      await ensureDirectoryExistsAsync(path.dirname(resolvedPath));
    }

    const value: TValue = await args.runAsync(resolvedPath);

    return {
      success: true,
      resolvedPath,
      value,
    };
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);

    args.logger.debug(args.onErrorLogMessage, {
      path: args.filePath,
      error: errorMessage,
    });

    return {
      success: false,
      errorMessage,
    };
  }
}
