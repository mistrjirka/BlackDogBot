import fs from "node:fs/promises";
import fsSync, { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export class DataLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataLockError";
  }
}

type Purpose = "runtime" | "migration" | "recovery";

interface LockMetadata {
  version: 1;
  pid: number;
  hostname: string;
  nonce: string;
  purpose: Purpose;
  createdAt: string;
}

interface OwnedFile {
  filePath: string;
  metadata: LockMetadata;
  dev: number;
  ino: number;
}

export interface DataLock {
  releaseAsync(): Promise<void>;
  releaseSync(): void;
}

const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const directoryFlags = readFlags | constants.O_DIRECTORY;
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function inspectionError(filePath: string, detail: string): DataLockError {
  return new DataLockError(`${detail} Inspect ${filePath} manually after stopping all bot and migration processes. Do not delete a lock owned by a running process.`);
}

function parseMetadata(content: string, filePath: string): LockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw inspectionError(filePath, "Data lock metadata is incomplete or invalid JSON.");
  }

  const record = value as Partial<LockMetadata> | null;
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0 || (record.pid ?? 0) > 2_147_483_647 ||
    typeof record.hostname !== "string" || !record.hostname.trim() ||
    typeof record.nonce !== "string" || record.nonce.length < 16 ||
    !["runtime", "migration", "recovery"].includes(record.purpose ?? "") ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw inspectionError(filePath, "Data lock metadata is corrupt or unsupported.");
  }
  return record as LockMetadata;
}

async function ensureDirectoryAsync(directory: string, privateMode: boolean): Promise<void> {
  let stat;
  let firstCreated: string | undefined;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    firstCreated = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DataLockError(`Data lock directory must be a real directory, not a symlink: ${directory}`);
  }
  if (privateMode) {
    await fs.chmod(directory, 0o700);
    await syncDirectoryAsync(directory);
  }
  if (firstCreated) {
    // Persist each newly created parent entry before migration writes can make
    // its backup essential, including a previously absent data root.
    const existingParent = path.dirname(firstCreated);
    for (let current = directory; ; current = path.dirname(current)) {
      await syncDirectoryAsync(current);
      if (current === existingParent) break;
    }
  }
}

async function metadataDirectoryAsync(dataDir: string): Promise<string> {
  if (!path.isAbsolute(dataDir)) throw new DataLockError("Data lock directory must be an absolute path.");
  const root = path.resolve(dataDir);
  await ensureDirectoryAsync(root, false);
  const metadataDir = path.join(root, ".migrations");
  await ensureDirectoryAsync(metadataDir, true);
  return metadataDir;
}

async function assertParentsAsync(filePath: string): Promise<void> {
  for (const directory of [path.dirname(path.dirname(filePath)), path.dirname(filePath)]) {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw inspectionError(directory, "Data lock directory was replaced or is a symlink.");
    }
  }
}

function assertParentsSync(filePath: string): void {
  for (const directory of [path.dirname(path.dirname(filePath)), path.dirname(filePath)]) {
    const stat = fsSync.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw inspectionError(directory, "Data lock directory was replaced or is a symlink.");
    }
  }
}

async function syncDirectoryAsync(directory: string): Promise<void> {
  const handle = await fs.open(directory, directoryFlags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNoRecoveryAsync(metadataDir: string): Promise<void> {
  const recoveryPath = path.join(metadataDir, "recovery.json");
  try {
    await fs.lstat(recoveryPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw inspectionError(recoveryPath, "Data lock recovery is in progress or left an unfinished recovery barrier.");
}

async function readOwnedFileAsync(filePath: string): Promise<OwnedFile> {
  await assertParentsAsync(filePath);
  let handle;
  try {
    handle = await fs.open(filePath, readFlags);
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw inspectionError(filePath, "Data lock must not be a symlink.");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096) {
      throw inspectionError(filePath, "Data lock must contain a small, complete metadata file.");
    }
    const metadata = parseMetadata(await handle.readFile("utf8"), filePath);
    return { filePath, metadata, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

function readOwnedFileSync(filePath: string): OwnedFile {
  assertParentsSync(filePath);
  const fd = fsSync.openSync(filePath, readFlags);
  try {
    const stat = fsSync.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096) {
      throw inspectionError(filePath, "Data lock must contain a small, complete metadata file.");
    }
    const metadata = parseMetadata(fsSync.readFileSync(fd, "utf8"), filePath);
    return { filePath, metadata, dev: stat.dev, ino: stat.ino };
  } finally {
    fsSync.closeSync(fd);
  }
}

function isSameOwner(first: OwnedFile, second: OwnedFile): boolean {
  return first.metadata.nonce === second.metadata.nonce &&
    first.dev === second.dev && first.ino === second.ino;
}

async function removeOwnedFileAsync(owned: OwnedFile): Promise<boolean> {
  let current;
  try {
    current = await readOwnedFileAsync(owned.filePath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (!isSameOwner(owned, current)) return false;

  const stat = await fs.lstat(owned.filePath);
  if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino) return false;
  try {
    await fs.unlink(owned.filePath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return false;
  }
  await syncDirectoryAsync(path.dirname(owned.filePath));
  return true;
}

function removeOwnedFileSync(owned: OwnedFile): void {
  const current = readOwnedFileSync(owned.filePath);
  if (!isSameOwner(owned, current)) return;
  const stat = fsSync.lstatSync(owned.filePath);
  if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino) return;
  fsSync.unlinkSync(owned.filePath);
  const fd = fsSync.openSync(path.dirname(owned.filePath), directoryFlags);
  try {
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
}

async function createOwnedFileAsync(filePath: string, purpose: Purpose): Promise<OwnedFile> {
  const metadata: LockMetadata = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    nonce: randomUUID(),
    purpose,
    createdAt: new Date().toISOString(),
  };
  const handle = await fs.open(filePath, createFlags, 0o600);
  let stat;
  try {
    await handle.writeFile(JSON.stringify(metadata) + "\n");
    await handle.sync();
    stat = await handle.stat();
  } catch {
    // Preserve incomplete metadata. Guessing ownership after a partial write
    // could remove another process's lock during manual recovery.
    throw inspectionError(filePath, "Could not persist data lock metadata.");
  } finally {
    await handle.close();
  }
  await syncDirectoryAsync(path.dirname(filePath));
  return { filePath, metadata, dev: stat.dev, ino: stat.ino };
}

function asDataLock(owned: OwnedFile): DataLock {
  let released = false;
  return {
    async releaseAsync(): Promise<void> {
      if (released) return;
      await removeOwnedFileAsync(owned);
      released = true;
    },
    releaseSync(): void {
      if (released) return;
      try {
        removeOwnedFileSync(owned);
        released = true;
      } catch {
        // Exit cleanup is best effort. Keep an unverifiable lock for explicit
        // recovery rather than deleting a file we can no longer identify.
      }
    },
  };
}

/** Never steals a lock, even when its recorded owner appears dead. */
export async function acquireDataLockAsync(
  dataDir: string,
  purpose: "runtime" | "migration",
): Promise<DataLock> {
  const metadataDir = await metadataDirectoryAsync(dataDir);
  await assertNoRecoveryAsync(metadataDir);
  const lockPath = path.join(metadataDir, "lock.json");

  let owned;
  try {
    owned = await createOwnedFileAsync(lockPath, purpose);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const current = await readOwnedFileAsync(lockPath);
    throw new DataLockError(`Data directory is locked by ${current.metadata.purpose} process ${current.metadata.pid} on ${current.metadata.hostname}. Stop the owner or use explicit stale-lock recovery. Lock: ${lockPath}`);
  }

  try {
    // A recovery process may have started between the first check and O_EXCL.
    await assertNoRecoveryAsync(metadataDir);
  } catch (error) {
    await removeOwnedFileAsync(owned);
    throw error;
  }
  return asDataLock(owned);
}

/**
 * Explicit recovery is limited to a validated local owner proven dead by
 * kill(pid, 0) returning ESRCH. A leftover recovery barrier is never stolen.
 */
export async function recoverStaleDataLockAsync(dataDir: string): Promise<void> {
  const metadataDir = await metadataDirectoryAsync(dataDir);
  const recoveryPath = path.join(metadataDir, "recovery.json");
  let barrier;
  try {
    barrier = await createOwnedFileAsync(recoveryPath, "recovery");
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw inspectionError(recoveryPath, "Another recovery is active or left an unfinished recovery barrier.");
    }
    throw error;
  }

  try {
    const lockPath = path.join(metadataDir, "lock.json");
    let owned;
    try {
      owned = await readOwnedFileAsync(lockPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (owned.metadata.purpose === "recovery") {
      throw inspectionError(lockPath, "Runtime lock has an invalid recovery purpose.");
    }
    if (owned.metadata.hostname !== os.hostname()) {
      throw inspectionError(lockPath, `Cannot recover a lock from another host (${owned.metadata.hostname}).`);
    }

    let dead = false;
    try {
      process.kill(owned.metadata.pid, 0);
    } catch (error) {
      if (hasCode(error, "ESRCH")) dead = true;
      else if (!hasCode(error, "EPERM")) throw error;
    }
    if (!dead) {
      throw new DataLockError(`Data lock owner ${owned.metadata.pid} is still running or cannot be probed. Stop that process before recovery. Lock: ${lockPath}`);
    }
    if (!await removeOwnedFileAsync(owned)) {
      throw inspectionError(lockPath, "Data lock changed during recovery. No replacement lock was removed.");
    }
  } finally {
    await removeOwnedFileAsync(barrier);
  }
}
