import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";

import { sendFileToolInputSchema } from "../shared/schemas/tool-schemas.js";
import type { FileSender } from "../shared/types/messaging.types.js";
import { extractErrorMessage } from "../utils/error.js";
import { resolveFilePath } from "../utils/file-tools-helper.js";
import { getUploadsDir, getWorkspaceDir } from "../utils/paths.js";

//#region Constants

export const MAX_SEND_FILE_BYTES: number = 25 * 1024 * 1024;

//#endregion Constants

//#region Interfaces

interface ISendFileResult {
  sent: boolean;
  messageId: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  error?: string;
}

//#endregion Interfaces

//#region Private functions

function _isInsideDirectory(rootPath: string, candidatePath: string): boolean {
  const relativePath: string = path.relative(rootPath, candidatePath);

  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function _resolveAllowedFilePathAsync(filePath: string): Promise<string> {
  const resolvedPath: string = path.resolve(resolveFilePath(filePath));
  const realFilePath: string = await fs.realpath(resolvedPath);
  const allowedRoots: string[] = [getWorkspaceDir(), getUploadsDir()];

  for (const root of allowedRoots) {
    let realRoot: string;

    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }

    if (_isInsideDirectory(realRoot, realFilePath)) {
      return realFilePath;
    }
  }

  throw new Error(
    "Access denied: send_file can only send files from the workspace or uploads directory.",
  );
}

//#endregion Private functions

//#region Factory

export function createSendFileTool(fileSender: FileSender) {
  return tool({
    description:
      "Send a file to the current chat as a document attachment. Relative paths resolve against the workspace directory " +
      "(~/.blackdogbot/workspace/). Only files inside the workspace or uploads directory can be sent. " +
      `Maximum file size is ${Math.floor(MAX_SEND_FILE_BYTES / (1024 * 1024))} MB. ` +
      "Use this for generated reports, PDFs, archives, CSV files, and other artifacts.",
    inputSchema: sendFileToolInputSchema,
    execute: async ({
      filePath,
      caption,
    }: {
      filePath: string;
      caption?: string | null;
    }): Promise<ISendFileResult> => {
      try {
        const realFilePath: string = await _resolveAllowedFilePathAsync(filePath);
        const stats = await fs.stat(realFilePath);

        if (!stats.isFile()) {
          return {
            sent: false,
            messageId: null,
            fileName: null,
            sizeBytes: null,
            error: "The provided path is not a regular file.",
          };
        }

        if (stats.size > MAX_SEND_FILE_BYTES) {
          return {
            sent: false,
            messageId: null,
            fileName: path.basename(realFilePath),
            sizeBytes: stats.size,
            error:
              `File is too large (${stats.size} bytes). ` +
              `The maximum size is ${MAX_SEND_FILE_BYTES} bytes.`,
          };
        }

        const fileBuffer: Buffer = await fs.readFile(realFilePath);
        const fileName: string = path.basename(realFilePath);
        const messageId: string | null = await fileSender(
          fileBuffer,
          fileName,
          caption ?? null,
        );

        return {
          sent: true,
          messageId,
          fileName,
          sizeBytes: fileBuffer.length,
        };
      } catch (error: unknown) {
        return {
          sent: false,
          messageId: null,
          fileName: null,
          sizeBytes: null,
          error: extractErrorMessage(error),
        };
      }
    },
  });
}

//#endregion Factory
