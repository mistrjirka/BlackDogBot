import type { Context } from "grammy";
import { writeFile } from "node:fs/promises";

import {
  compressImageToLimitAsync,
  getImageExtensionForMimeType,
  getUniqueUploadPathAsync,
  sanitizeImageFileName,
} from "../../utils/image-helpers.js";
import type { IChatImageAttachment } from "../../agent/types.js";

//#region Interfaces

export interface IExtractedTelegramImage {
  imageBuffer: Buffer;
  mediaType: string;
  originalFileName: string | null;
  captionText: string | null;
}

export interface IPreparedTelegramImage {
  imageAttachment: IChatImageAttachment;
  savedPath: string;
  mediaType: string;
  imageByteLength: number;
}

//#endregion Interfaces

//#region Public Functions

export async function extractTelegramImageAsync(
  ctx: Context,
  botToken: string,
): Promise<IExtractedTelegramImage | null> {
  const message = ctx.message;
  if (!message) {
    return null;
  }

  let fileId: string | null = null;
  let mediaType: string = "image/jpeg";
  let originalFileName: string | null = null;

  if ("photo" in message && Array.isArray(message.photo) && message.photo.length > 0) {
    const largestPhoto = message.photo[message.photo.length - 1];
    fileId = largestPhoto.file_id;
    mediaType = "image/jpeg";
    originalFileName = null;
  } else if ("document" in message && message.document) {
    const document = message.document;
    const mimeType: string = document.mime_type ?? "";
    if (!mimeType.startsWith("image/")) {
      return null;
    }
    fileId = document.file_id;
    mediaType = mimeType;
    originalFileName = document.file_name ?? null;
  }

  if (!fileId) {
    return null;
  }

  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram API did not return file_path for image.");
  }

  const url: string = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response: Response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram image (${response.status} ${response.statusText}).`);
  }

  const arrayBuffer: ArrayBuffer = await response.arrayBuffer();
  const imageBuffer: Buffer = Buffer.from(arrayBuffer);

  return {
    imageBuffer,
    mediaType,
    originalFileName,
    captionText: "caption" in message && typeof message.caption === "string" ? message.caption : null,
  };
}

export async function prepareAndSaveTelegramImageAsync(input: {
  extracted: IExtractedTelegramImage;
  maxImageBytes: number;
  uploadsDir: string;
  chatId: string;
  now: Date;
}): Promise<IPreparedTelegramImage> {
  let imageBuffer: Buffer = input.extracted.imageBuffer;
  let resolvedMediaType: string = input.extracted.mediaType;

  if (imageBuffer.length > input.maxImageBytes) {
    const compressed: Buffer = await compressImageToLimitAsync(imageBuffer, input.maxImageBytes);
    if (compressed !== imageBuffer) {
      imageBuffer = compressed;
      resolvedMediaType = "image/jpeg";
    }
  }

  if (imageBuffer.length > input.maxImageBytes) {
    throw new Error(
      `Image is too large (${imageBuffer.length} bytes) and could not be compressed below ${input.maxImageBytes} bytes.`,
    );
  }

  const extension: string = getImageExtensionForMimeType(resolvedMediaType);
  const preferredName: string = input.extracted.originalFileName
    ? sanitizeImageFileName(input.extracted.originalFileName)
    : `telegram_${input.chatId}_${input.now.getTime()}${extension}`;

  const fileNameWithExt: string = preferredName.includes(".") ? preferredName : `${preferredName}${extension}`;
  const uniquePath: string = await getUniqueUploadPathAsync(fileNameWithExt);

  await writeFile(uniquePath, imageBuffer);

  return {
    imageAttachment: {
      imageBuffer,
      mediaType: resolvedMediaType,
    },
    savedPath: uniquePath,
    mediaType: resolvedMediaType,
    imageByteLength: imageBuffer.length,
  };
}

//#endregion Public Functions
