import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

import { getUploadsDir } from "./paths.js";

//#region Constants

const _ImageExtensionsByMimeType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

const _FallbackImageExtension: string = ".jpg";

//#endregion Constants

//#region Public functions

export function getImageExtensionForMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) {
    return _FallbackImageExtension;
  }

  const normalizedMimeType: string = mimeType.toLowerCase();
  return _ImageExtensionsByMimeType[normalizedMimeType] ?? _FallbackImageExtension;
}

export function sanitizeImageFileName(fileName: string): string {
  const trimmed: string = fileName.trim();
  const noSeparators: string = trimmed.replace(/[\\/]+/g, "_");
  const safe: string = noSeparators.replace(/[^a-zA-Z0-9._-]+/g, "_");

  if (safe.length === 0) {
    return "image";
  }

  return safe;
}

export async function getUniqueUploadPathAsync(fileName: string): Promise<string> {
  const uploadsDir: string = getUploadsDir();
  const sanitizedName: string = sanitizeImageFileName(fileName);
  const extension: string = path.extname(sanitizedName);
  const baseName: string = extension.length > 0
    ? sanitizedName.slice(0, -extension.length)
    : sanitizedName;

  let candidate: string = path.join(uploadsDir, sanitizedName);
  let suffix: number = 1;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(uploadsDir, `${baseName}_${suffix}${extension}`);
      suffix++;
    } catch {
      return candidate;
    }
  }
}

export async function compressImageToLimitAsync(input: Buffer, maxBytes: number): Promise<Buffer> {
  if (input.length <= maxBytes) {
    return input;
  }

  const metadata: sharp.Metadata = await sharp(input).metadata();
  const width: number = metadata.width ?? 2048;
  const height: number = metadata.height ?? 2048;

  const qualityLevels: number[] = [90, 80, 70, 60, 50, 40, 30];
  const maxDimensions: number[] = [Math.max(width, height), 3072, 2048, 1536, 1280, 1024];

  for (const maxDimension of maxDimensions) {
    for (const quality of qualityLevels) {
      const compressed: Buffer = await sharp(input)
        .rotate()
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality,
          mozjpeg: true,
        })
        .toBuffer();

      if (compressed.length <= maxBytes) {
        return compressed;
      }
    }
  }

  return input;
}

//#endregion Public functions
