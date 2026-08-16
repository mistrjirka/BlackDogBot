import fs from "node:fs/promises";

export const MAX_SKILL_FILE_BYTES: number = 1024 * 1024;

export async function readFileBoundedAsync(filePath: string, maxBytes: number = MAX_SKILL_FILE_BYTES): Promise<string> {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile()) {
    throw new Error("File is not a regular file");
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer: Buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new Error(`File exceeds the ${maxBytes} byte limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}
