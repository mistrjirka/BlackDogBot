import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "langchain";

import { readImageToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { type IFileReadTracker } from "../utils/file-tools-helper.js";
import { runFileOperationAsync } from "../utils/file-operation-helper.js";

//#region Interfaces

interface IReadImageResult {
  success: boolean;
  data: string | undefined;
  mediaType: string | undefined;
  bytes: number | undefined;
  message: string;
}

interface IReadImagePayload {
  base64: string;
  mediaType: string;
  bytes: number;
}

//#endregion Interfaces

//#region Constants

const maxImageBytes: number = 10 * 1024 * 1024;

const imageMediaTypesByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

//#endregion Constants

//#region Factory

export function createReadImageTool(readTracker: IFileReadTracker) {
  return tool(
    async ({ filePath }: { filePath: string }): Promise<IReadImageResult> => {
      const logger: LoggerService = LoggerService.getInstance();

      const operationResult = await runFileOperationAsync<IReadImagePayload>({
        logger,
        filePath,
        onErrorLogMessage: "Image read failed",
        runAsync: async (resolvedPath: string): Promise<IReadImagePayload> => {
          const ext: string = path.extname(resolvedPath).toLowerCase();
          const mediaType: string | undefined = imageMediaTypesByExt[ext];

          if (!mediaType) {
            throw new Error(`Unsupported image extension: ${ext || "(none)"}. Supported: ${Object.keys(imageMediaTypesByExt).join(", ")}`);
          }

          const stat = await fs.stat(resolvedPath);
          if (!stat.isFile()) {
            throw new Error("Path is not a regular file.");
          }

          if (stat.size > maxImageBytes) {
            throw new Error(`Image is too large (${stat.size} bytes). Maximum allowed is ${maxImageBytes} bytes.`);
          }

          const buffer: Buffer = await fs.readFile(resolvedPath);
          const base64: string = buffer.toString("base64");

          readTracker.markRead(resolvedPath);

          return {
            base64,
            mediaType,
            bytes: buffer.length,
          };
        },
      });

      if (!operationResult.success) {
        return {
          success: false,
          data: undefined,
          mediaType: undefined,
          bytes: undefined,
          message: operationResult.errorMessage,
        };
      }

      logger.debug("Image read successfully", {
        path: operationResult.resolvedPath,
        bytes: operationResult.value.bytes,
        mediaType: operationResult.value.mediaType,
      });

      return {
        success: true,
        data: operationResult.value.base64,
        mediaType: operationResult.value.mediaType,
        bytes: operationResult.value.bytes,
        message: `Image read successfully (${operationResult.value.bytes} bytes).`,
      };
    },
    {
      name: "read_image",
      description:
        "Read an image file and pass it to the model as media content. " +
        "Use this when you want the model to inspect screenshots or other local images. " +
        "Supports png/jpg/jpeg/gif/webp/bmp/svg up to 10MB.",
      schema: readImageToolInputSchema,
    },
  );
}

//#endregion Factory
