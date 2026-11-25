import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export interface DatabasePathCandidate {
  path: string; exists: boolean; populated: boolean; fileCount: number; totalBytes: number; fingerprint: string;
}
export class DatabasePathMigrationError extends Error {
  readonly transactionId?: string;
  readonly candidates?: DatabasePathCandidate[];
  constructor(message: string, transactionId?: string, candidates?: DatabasePathCandidate[]) {
    super(message);
    this.name = "DatabasePathMigrationError";
    this.transactionId = transactionId;
    this.candidates = candidates;
  }
}
export function fail(message: string, transactionId?: string): never {
  throw new DatabasePathMigrationError(message, transactionId);
}
export const HASH = /^[a-f0-9]{64}$/;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIR = READ | constants.O_DIRECTORY;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const publisher = fileURLToPath(new URL("../../scripts/atomic-publish.py", import.meta.url));
export const sha256 = (content: Buffer | string): string => crypto.createHash("sha256").update(content).digest("hex");
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + path.sep);
export function identity(stat: Stats): string { return String(stat.dev) + ":" + String(stat.ino); }
function signature(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs].join(":");
}
export function mode(stat: Stats): number { return stat.mode & 0o777; }

export async function safePathAsync(value: string, allowMissing = false): Promise<string> {
  if (!path.isAbsolute(value)) fail("Database migration paths must be absolute.");
  const normalized = path.resolve(value);
  const parts = normalized.split(path.sep).filter(Boolean);
  let current = path.parse(normalized).root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat: Stats;
    try { stat = await fs.lstat(current); }
    catch (error) { if (allowMissing && missing(error)) return normalized; throw error; }
    if (stat.isSymbolicLink()) fail("Database migration paths must not contain symlinks.");
    if (index < parts.length - 1 && !stat.isDirectory()) fail("A database migration parent is not a directory.");
  }
  return normalized;
}
export async function syncDirectoryAsync(directory: string): Promise<void> {
  const handle = await fs.open(directory, DIR);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function ensureDirectoryAsync(directory: string, privateMode = false): Promise<void> {
  const target = await safePathAsync(directory, true);
  let first: string | undefined;
  try { first = await fs.mkdir(target, { recursive: true, mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("A database migration directory was replaced.");
  if (privateMode) await fs.chmod(target, 0o700);
  if (first) for (let directory = target; ; directory = path.dirname(directory)) {
    await syncDirectoryAsync(directory);
    if (directory === path.dirname(first)) break;
  }
}
export async function readFileAsync(file: string, maximum = 16 * 1024 * 1024): Promise<{ content: Buffer; mode: number; identity: string } | null> {
  await safePathAsync(file, true);
  let handle;
  try { handle = await fs.open(file, READ); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) fail("Database migration metadata must be a regular file of supported size.");
    const content = await handle.readFile();
    const after = await handle.stat();
    if (signature(before) !== signature(after)) fail("Database migration metadata changed while being read.");
    return { content, mode: mode(before), identity: identity(before) };
  } finally { await handle.close(); }
}
export async function writePrivateAsync(file: string, content: Buffer | string): Promise<void> {
  await safePathAsync(path.dirname(file));
  const handle = await fs.open(file, WRITE, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
export async function replaceFileAsync(file: string, content: Buffer, permissions: number): Promise<void> {
  await safePathAsync(file, true);
  const temporary = path.join(path.dirname(file), ".database-path-" + crypto.randomUUID() + ".tmp");
  try {
    const handle = await fs.open(temporary, WRITE, 0o600);
    try { await handle.writeFile(content); await handle.chmod(permissions); await handle.sync(); }
    finally { await handle.close(); }
    await safePathAsync(path.dirname(file));
    await fs.rename(temporary, file);
    await syncDirectoryAsync(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
export async function atomicPublishAsync(source?: string, destination?: string): Promise<void> {
  const args = source && destination ? [source, destination] : ["--check"];
  try {
    const result = await promisify(execFile)("python3", [publisher, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    let output: unknown;
    try { output = JSON.parse(result.stdout); } catch { fail("Atomic database publication returned an invalid response."); }
    if (!record(output) || output.protocolVersion !== 1 || output.status !== (source ? "published" : "supported")) {
      fail("Atomic database publication did not complete.");
    }
  } catch (error) {
    if (error instanceof DatabasePathMigrationError) throw error;
    let output: unknown;
    try { output = JSON.parse((error as { stdout?: string }).stdout ?? ""); } catch { output = null; }
    if (record(output) && output.error === "destination_exists") {
      fail("Database publication refused an existing destination. Both copies were preserved.");
    }
    fail("Atomic database publication requires Python 3 and Linux renameat2 support. No existing destination was replaced.");
  }
}

export interface StoreEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  size?: number;
  sha256?: string;
}
export interface StoreSnapshot {
  exists: boolean;
  rootIdentity: string | null;
  entries: StoreEntry[];
  identities: string[];
  fingerprint: string;
  fileCount: number;
  totalBytes: number;
}
function inventoryDigest(entries: StoreEntry[]): string { return sha256(JSON.stringify(entries)); }
async function hashFileAsync(file: string, expected?: Stats, destination?: string): Promise<{ size: number; sha256: string }> {
  await safePathAsync(file);
  const input = await fs.open(file, READ);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || (expected && signature(before) !== signature(expected))) fail("A database source file changed during inspection.");
    if (destination) output = await fs.open(destination, WRITE, 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const result = await input.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      size += result.bytesRead;
      if (output) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await output.write(chunk, offset, chunk.length - offset, null);
          if (!written.bytesWritten) fail("The database copy could not be completed.");
          offset += written.bytesWritten;
        }
      }
    }
    if (size !== before.size || signature(before) !== signature(await input.stat())) fail("A database source file changed during copying.");
    if (output) { await output.chmod(mode(before)); await output.sync(); }
    return { size, sha256: hash.digest("hex") };
  } finally { await output?.close(); await input.close(); }
}
export async function inspectStoreAsync(directory: string): Promise<StoreSnapshot> {
  await safePathAsync(directory, true);
  let root: Stats;
  try { root = await fs.lstat(directory); }
  catch (error) {
    if (missing(error)) return { exists: false, rootIdentity: null, entries: [], identities: [], fingerprint: inventoryDigest([]), fileCount: 0, totalBytes: 0 };
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) fail("A configured database location is not a real directory.");
  const entries: StoreEntry[] = [], identities: string[] = [];
  let fileCount = 0, totalBytes = 0;
  async function walk(relative: string): Promise<void> {
    const full = path.join(directory, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("A database store contains a symlink or special file.");
    if (stat.mode & 0o7000) fail("Database stores with special permission bits need manual inspection.");
    if (entries.length >= 200_000) fail("This database inventory is too large for an automatic path migration.");
    identities.push(signature(stat));
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: mode(stat) });
      const names = (await fs.readdir(full)).sort();
      for (const name of names) await walk(relative ? relative + "/" + name : name);
      if (signature(stat) !== signature(await fs.lstat(full))) fail("The database directory changed while being inspected. Stop all writers and retry.");
    } else {
      const hash = await hashFileAsync(full, stat);
      entries.push({ path: relative, type: "file", mode: mode(stat), ...hash });
      fileCount++;
      totalBytes += hash.size;
    }
  }
  await walk("");
  return { exists: true, rootIdentity: identity(root), entries, identities, fingerprint: inventoryDigest(entries), fileCount, totalBytes };
}
export function sameStore(first: StoreSnapshot, second: StoreSnapshot, identities = false): boolean {
  return first.exists === second.exists && first.fingerprint === second.fingerprint
    && (!identities || (first.rootIdentity === second.rootIdentity && JSON.stringify(first.identities) === JSON.stringify(second.identities)));
}
export function populated(store: StoreSnapshot): boolean { return store.entries.length > 1; }
export function destinationInventory(source: StoreSnapshot | null): StoreEntry[] {
  const entries = source?.exists ? source.entries.map(entry => ({ ...entry })) : [{ path: "", type: "directory" as const, mode: 0o700 }];
  entries[0].mode = 0o700;
  return entries;
}
export async function copyStoreAsync(source: string | null, expected: StoreSnapshot | null, target: string): Promise<void> {
  await fs.mkdir(target, { mode: 0o700 });
  if (source && expected) for (const entry of expected.entries) {
    if (!entry.path) continue;
    const destination = path.join(target, entry.path);
    if (entry.type === "directory") await fs.mkdir(destination, { mode: 0o700 });
    else {
      const copied = await hashFileAsync(path.join(source, entry.path), undefined, destination);
      if (copied.sha256 !== entry.sha256 || copied.size !== entry.size) fail("The legacy database changed after migration planning.");
    }
  }
  if (expected) for (const entry of [...expected.entries].reverse()) if (entry.type === "directory" && entry.path) {
    await fs.chmod(path.join(target, entry.path), entry.mode);
    await syncDirectoryAsync(path.join(target, entry.path));
  }
  await syncDirectoryAsync(target);
}
export function decodeInventory(raw: unknown): StoreEntry[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200_000) fail("Database migration inventory is incomplete.");
  const seen = new Map<string, unknown>();
  for (const item of raw) {
    if (!record(item) || typeof item.path !== "string" || item.path.includes("\\") || path.isAbsolute(item.path)
      || (item.path !== "" && item.path.split("/").some(part => !part || part === "." || part === ".."))
      || seen.has(item.path) || !["file", "directory"].includes(String(item.type))
      || !Number.isInteger(item.mode) || (item.mode as number) < 0 || (item.mode as number) > 0o777
      || (item.type === "file" && (!Number.isSafeInteger(item.size) || (item.size as number) < 0 || typeof item.sha256 !== "string" || !HASH.test(item.sha256)))) {
      fail("Database migration inventory contains an unsafe entry.");
    }
    if (item.path === "" ? item.type !== "directory" : seen.get(path.posix.dirname(item.path) === "." ? "" : path.posix.dirname(item.path)) !== "directory") {
      fail("Database migration inventory contains an invalid parent.");
    }
    seen.set(item.path, item.type);
  }
  if ((raw[0] as StoreEntry).path !== "") fail("Database migration inventory omits its root.");
  return raw as StoreEntry[];
}
export async function verifyInventoryAsync(directory: string, entries: StoreEntry[]): Promise<StoreSnapshot> {
  const actual = await inspectStoreAsync(directory);
  if (!actual.exists || actual.fingerprint !== inventoryDigest(entries)) fail("The migrated database changed. Automatic rollback would discard newer data, so it was refused.");
  return actual;
}
