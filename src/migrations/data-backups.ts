import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import { configSchema } from "../shared/schemas/config.schemas.js";
import { acquireDataLockAsync } from "./data-lock.js";

export class DataBackupError extends Error {
  constructor(message: string) { super(message); this.name = "DataBackupError"; }
}

export const DATA_BACKUP_EXCLUSIONS = [
  "deploy", "models", "cache", "logs",
  ".migrations/lock.json", ".migrations/recovery.json",
] as const;
const ROOT_FILES = ["manifest.json", "manifest.sha256", "payload"];
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIR = READ | constants.O_DIRECTORY;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const SCHEMA_FILE = ".data-schema.json";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const HASH = /^[0-9a-f]{64}$/;

const ATOMIC_PUBLISH_SCRIPT = fileURLToPath(new URL("../../scripts/atomic-publish.py", import.meta.url));

async function atomicPublisherAsync(args: string[]): Promise<void> {
  if (process.platform !== "linux") fail("Backup creation and restore require Linux with atomic renameat2 support.");
  let stdout: string;
  try {
    const response = await promisify(execFile)("python3", [ATOMIC_PUBLISH_SCRIPT, ...args], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
    });
    stdout = response.stdout;
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    let response: unknown;
    try { response = output ? JSON.parse(output) : undefined; } catch { response = undefined; }
    if (record(response) && response.error === "destination_exists") {
      fail("Atomic publication refused because the destination now exists. Its contents were preserved.");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT"
      || (record(response) && response.error === "linux_renameat2_required")) {
      fail("Backup creation and restore require Python 3 and Linux renameat2(RENAME_NOREPLACE) support. Install the prerequisite or use a supported Linux host.");
    }
    fail("Atomic backup publication failed. No existing destination was replaced. Inspect the staged files and filesystem support.");
  }
  let result: unknown;
  try { result = JSON.parse(stdout); } catch { return fail("Atomic publication helper returned an invalid response."); }
  const expected = args[0] === "--check" ? "supported" : "published";
  if (!record(result) || result.protocolVersion !== 1 || result.status !== expected) {
    fail("Atomic publication helper returned an unsupported response.");
  }
}

interface ExternalReference {
  field: string;
  configuredPath: string;
  reason: "read-only skill source";
}
export interface BackupCoverage {
  protocolVersion: 1;
  sourceDataDir: string;
  scope: "blackdogbot-data-directory";
  exclusions: string[];
  externalReferences: ExternalReference[];
}
interface FileEntry { path: string; type: "file"; mode: number; size: number; sha256: string }
interface DirectoryEntry { path: string; type: "directory"; mode: number }
type Entry = FileEntry | DirectoryEntry;
interface Manifest extends BackupCoverage {
  formatVersion: 1;
  status: "complete";
  createdAt: string;
  rootMode: number;
  dataSchema: unknown;
  fileCount: number;
  totalBytes: number;
  entries: Entry[];
  sqliteDatabases: string[];
}
interface SourceEntry {
  path: string;
  type: "file" | "directory";
  stat: Stats;
}
interface SourceTree { root: Stats; entries: SourceEntry[] }
interface FileHash { size: number; sha256: string; header: Buffer }
interface VerifiedBackup {
  root: string;
  manifest: Manifest;
  manifestSha256: string;
}

function fail(message: string): never { throw new DataBackupError(message); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function sha(content: Buffer | string): string { return crypto.createHash("sha256").update(content).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) fail(`${label} must be an absolute path.`);
  return path.resolve(value);
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function excluded(relative: string): boolean {
  return DATA_BACKUP_EXCLUSIONS.some(item => relative === item || relative.startsWith(item + "/"));
}
function validRelative(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function mode(stat: Stats): number { return stat.mode & 0o7777; }
function sameStat(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs && mode(first) === mode(second);
}

/** Check every existing ancestor so a symlink cannot disguise a destination inside the source. */
async function safeAbsoluteAsync(value: string, label: string, allowMissing = false): Promise<string> {
  const resolved = absolute(value, label);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (missing(error) && allowMissing) return resolved;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`${label} must not contain symlinks.`);
    if (index < parts.length - 1 && !stat.isDirectory()) fail(`${label} has a non-directory parent.`);
  }
  return resolved;
}
async function requireDirectoryAsync(value: string, label: string): Promise<string> {
  const resolved = await safeAbsoluteAsync(value, label);
  if (!(await fs.lstat(resolved)).isDirectory()) fail(`${label} must be an existing directory.`);
  return resolved;
}
async function requireAbsentAsync(value: string, label: string): Promise<string> {
  const resolved = await safeAbsoluteAsync(value, label, true);
  try { await fs.lstat(resolved); }
  catch (error) { if (missing(error)) return resolved; throw error; }
  return fail(`${label} must not already exist. Existing files are never replaced.`);
}
async function syncDirAsync(directory: string): Promise<void> {
  const handle = await fs.open(directory, DIR);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function createParentsAsync(directory: string): Promise<void> {
  await safeAbsoluteAsync(directory, "Destination parent", true);
  const first = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await requireDirectoryAsync(directory, "Destination parent");
  if (first) {
    const parent = path.dirname(first);
    for (let current = directory; ; current = path.dirname(current)) {
      await syncDirAsync(current);
      if (current === parent) break;
    }
  }
}
async function readSmallAsync(file: string, limit = 16 * 1024 * 1024): Promise<Buffer> {
  const handle = await fs.open(file, READ);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail("Backup metadata must be a bounded regular file.");
    return await handle.readFile();
  } finally { await handle.close(); }
}
function parseJson(content: Buffer, label: string): unknown {
  try { return JSON.parse(content.toString("utf8")) as unknown; }
  catch { return fail(`${label} is not valid JSON.`); }
}
function expandHome(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
async function requireCoveredPathAsync(root: string, value: string, field: string): Promise<void> {
  if (!path.isAbsolute(value)) {
    fail(`${field} is relative or uses an unsupported home shorthand. Inspect its actual service location and configure an absolute path before backup.`);
  }
  const resolved = path.resolve(value);
  if (!within(root, resolved) || excluded(path.relative(root, resolved).split(path.sep).join("/"))) {
    fail(`${field} points to mutable data outside this snapshot's coverage. Back up or move that store explicitly before upgrading.`);
  }
  await safeAbsoluteAsync(resolved, field, true);
}

async function coverageAsync(dataDir: string): Promise<BackupCoverage & { configSha256: string }> {
  await atomicPublisherAsync(["--check"]);
  const root = await requireDirectoryAsync(dataDir, "Source data directory");
  const configPath = await safeAbsoluteAsync(path.join(root, "config.yaml"), "Configuration");
  const content = await readSmallAsync(configPath);
  let raw: unknown;
  try { raw = parseYaml(content.toString("utf8")); }
  catch { return fail("Cannot determine backup coverage because config.yaml is invalid YAML."); }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) fail("Cannot determine backup coverage because config.yaml is incompatible. Correct its fields first.");
  const config = parsed.data;

  // VectorStoreService currently passes this value to mkdir/connect verbatim.
  // Expanding '~' here would falsely certify coverage of a different database.
  if (config.knowledge.embeddingProvider) {
    await requireCoveredPathAsync(root, config.knowledge.lancedbPath, "knowledge.lancedbPath");
  }
  const providerKeys = { openrouter: "openrouter", "openai-compatible": "openaiCompatible", "lm-studio": "lmStudio" } as const;
  const activeProviders = new Set([config.ai.provider, ...(config.ai.fallbacks ?? []).map(item => item.provider)]);
  for (const provider of activeProviders) {
    const configured = config.ai[providerKeys[provider]]?.profilesDir?.trim();
    if (configured) {
      // ModelProfileService expands home and writes missing default profiles.
      await requireCoveredPathAsync(root, expandHome(configured), `ai.${providerKeys[provider]}.profilesDir`);
    }
  }
  const externalReferences: ExternalReference[] = [];
  for (const configured of config.skills.directories) {
    const expanded = expandHome(configured.trim());
    if (!path.isAbsolute(expanded) || !within(root, path.resolve(expanded))
      || excluded(path.relative(root, path.resolve(expanded)).split(path.sep).join("/"))) {
      // SkillLoader reads these roots. Their mutable per-skill state is stored
      // under DATA/skill-state, while package runtimes are installed separately.
      externalReferences.push({ field: "skills.directories", configuredPath: configured, reason: "read-only skill source" });
    }
  }
  return {
    protocolVersion: 1, sourceDataDir: root, scope: "blackdogbot-data-directory",
    exclusions: [...DATA_BACKUP_EXCLUSIONS], externalReferences, configSha256: sha(content),
  };
}

/** Read-only coverage check for an upgrade preflight while the service still runs. */
export async function validateDataBackupSourceAsync(dataDir: string): Promise<BackupCoverage> {
  const { configSha256: _configSha256, ...coverage } = await coverageAsync(dataDir);
  return coverage;
}
async function scanAsync(root: string, omitExcluded: boolean): Promise<SourceTree> {
  const entries: SourceEntry[] = [];
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("Snapshot root is not a real directory.");
  async function walk(relative: string): Promise<void> {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      const item = relative ? relative + "/" + name : name;
      if (!validRelative(item)) fail("A source filename cannot be represented safely in a snapshot.");
      if (omitExcluded && excluded(item)) continue;
      const stat = await fs.lstat(path.join(root, item));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        fail(`Snapshot source contains a symlink or special file: ${item}.`);
      }
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) fail("Snapshot source has an unsupported file size.");
      entries.push({ path: item, type: stat.isDirectory() ? "directory" : "file", stat });
      if (stat.isDirectory()) await walk(item);
    }
  }
  await walk("");
  return { root: rootStat, entries };
}
function counts(entries: SourceEntry[] | Entry[]): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  for (const item of entries) if (item.type === "file") {
    fileCount++;
    totalBytes += "stat" in item ? item.stat.size : item.size;
  }
  if (!Number.isSafeInteger(totalBytes)) fail("Snapshot total size is unsupported.");
  return { fileCount, totalBytes };
}
export async function planDataBackupAsync(dataDir: string): Promise<BackupCoverage & {
  status: "planned"; fileCount: number; totalBytes: number;
}> {
  const coverage = await validateDataBackupSourceAsync(dataDir);
  return { ...coverage, status: "planned", ...counts((await scanAsync(coverage.sourceDataDir, true)).entries) };
}

async function hashFileAsync(file: string, expected?: Stats, target?: string): Promise<FileHash> {
  const input = await fs.open(file, READ);
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await input.stat();
    if (!before.isFile() || (expected && !sameStat(before, expected))) fail("Source changed while creating the snapshot. Stop every writer and retry.");
    if (target) output = await fs.open(target, WRITE, 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    let header = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (!size) header = Buffer.from(chunk.subarray(0, 16));
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
      size += bytesRead;
    }
    if (size !== before.size || !sameStat(before, await input.stat())) fail("Source changed while creating the snapshot. Stop every writer and retry.");
    if (output) { await output.chmod(0o600); await output.sync(); }
    return { size, sha256: hash.digest("hex"), header };
  } finally {
    await input.close();
    if (output) await output.close();
  }
}
function isSqlite(relative: string, hash: FileHash): boolean {
  return hash.header.equals(SQLITE_HEADER) || (relative.startsWith("databases/") && /\.(?:db|sqlite|sqlite3)$/i.test(relative));
}
async function validateSqliteAsync(payload: string, entries: Entry[], databases: string[]): Promise<void> {
  const files = new Set(entries.filter(entry => entry.type === "file").map(entry => entry.path));
  for (const file of files) {
    if (file.startsWith("databases/") && /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/i.test(file)) {
      const base = file.replace(/-(?:wal|shm|journal)$/i, "");
      if (!files.has(base)) fail(`Snapshot contains an orphaned SQLite sidecar: ${file}.`);
    }
  }
  if (!databases.length) return;
  const audit = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-sqlite-backup-check-"));
  try {
    for (let index = 0; index < databases.length; index++) {
      const relative = databases[index];
      const directory = path.join(audit, String(index));
      await fs.mkdir(directory, { mode: 0o700 });
      const target = path.join(directory, "database");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (files.has(relative + suffix)) await fs.copyFile(path.join(payload, relative + suffix), target + suffix, constants.COPYFILE_EXCL);
      }
      let db: Database.Database | undefined;
      try {
        // Recovery/checkpoint may alter this disposable copy, never the backup.
        db = new Database(target, { fileMustExist: true });
        const checks = db.pragma("integrity_check") as { integrity_check: string }[];
        if (checks.length !== 1 || checks[0].integrity_check !== "ok") fail(`SQLite integrity verification failed: ${relative}.`);
      } catch {
        fail(`SQLite integrity verification failed: ${relative}. Preserve the original database and its WAL files.`);
      } finally { db?.close(); }
    }
  } finally { await fs.rm(audit, { recursive: true, force: true }); }
}
async function writePrivateAsync(file: string, content: string): Promise<void> {
  const handle = await fs.open(file, WRITE, 0o600);
  try { await handle.writeFile(content); await handle.chmod(0o600); await handle.sync(); }
  finally { await handle.close(); }
}
function validMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o7777;
}
function decodeManifest(raw: unknown): Manifest {
  if (!record(raw) || raw.formatVersion !== 1 || raw.protocolVersion !== 1 || raw.status !== "complete"
    || raw.scope !== "blackdogbot-data-directory" || typeof raw.sourceDataDir !== "string" || !path.isAbsolute(raw.sourceDataDir)
    || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
    || !validMode(raw.rootMode) || !Array.isArray(raw.entries) || !Array.isArray(raw.externalReferences)
    || JSON.stringify(raw.exclusions) !== JSON.stringify(DATA_BACKUP_EXCLUSIONS)
    || !Array.isArray(raw.sqliteDatabases) || !Number.isSafeInteger(raw.fileCount) || !Number.isSafeInteger(raw.totalBytes)
    || !Object.hasOwn(raw, "dataSchema")) fail("Backup manifest is incomplete or unsupported.");
  for (const reference of raw.externalReferences) {
    if (!record(reference) || reference.field !== "skills.directories"
      || typeof reference.configuredPath !== "string" || reference.reason !== "read-only skill source") {
      fail("Backup manifest has an invalid external source reference.");
    }
  }
  const known = new Map<string, Entry>();
  for (const entry of raw.entries) {
    if (!record(entry) || !validRelative(entry.path) || excluded(entry.path) || known.has(entry.path) || !validMode(entry.mode)
      || !["file", "directory"].includes(entry.type as string)) fail("Backup manifest contains an unsafe or duplicate path.");
    if (entry.type === "file" && (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0
      || typeof entry.sha256 !== "string" || !HASH.test(entry.sha256))) fail("Backup manifest contains invalid file metadata.");
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && known.get(parent)?.type !== "directory") fail("Backup manifest omits a parent directory.");
    known.set(entry.path, entry as unknown as Entry);
  }
  if (known.get("config.yaml")?.type !== "file") fail("Backup manifest omits the application configuration.");
  if (raw.sqliteDatabases.some(item => typeof item !== "string" || known.get(item)?.type !== "file")
    || new Set(raw.sqliteDatabases).size !== raw.sqliteDatabases.length) fail("Backup manifest contains invalid SQLite paths.");
  const actual = counts([...known.values()]);
  if (actual.fileCount !== raw.fileCount || actual.totalBytes !== raw.totalBytes) fail("Backup manifest counts do not match its files.");
  return raw as unknown as Manifest;
}
async function verifyPayloadAsync(root: string, manifest: Manifest): Promise<void> {
  const tree = await scanAsync(root, false);
  if (tree.entries.length !== manifest.entries.length) fail("Backup payload contains missing or unexpected entries.");
  const expected = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const databases: string[] = [];
  for (const item of tree.entries) {
    const entry = expected.get(item.path);
    if (!entry || entry.type !== item.type) fail("Backup payload contains missing or unexpected entries.");
    if (mode(item.stat) & 0o077) fail("Backup payload permissions are not private.");
    if (entry.type === "file") {
      const hash = await hashFileAsync(path.join(root, entry.path), item.stat);
      if (hash.size !== entry.size || hash.sha256 !== entry.sha256) fail(`Backup checksum failed: ${entry.path}.`);
      if (isSqlite(entry.path, hash)) databases.push(entry.path);
    }
  }
  if (JSON.stringify(databases.sort()) !== JSON.stringify([...manifest.sqliteDatabases].sort())) fail("Backup SQLite inventory does not match its payload.");
  const schemaFile = manifest.entries.find(entry => entry.path === SCHEMA_FILE);
  const schema = schemaFile ? parseJson(await readSmallAsync(path.join(root, SCHEMA_FILE)), "Data schema") : null;
  if (JSON.stringify(schema) !== JSON.stringify(manifest.dataSchema)) fail("Backup data-schema metadata does not match its payload.");
  await validateSqliteAsync(root, manifest.entries, databases);
}
async function verifyInternalAsync(backupPath: string): Promise<VerifiedBackup> {
  const root = await requireDirectoryAsync(backupPath, "Backup directory");
  if (mode(await fs.lstat(root)) & 0o077) fail("Backup directory permissions are not private.");
  const names = (await fs.readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...ROOT_FILES].sort())) fail("Backup directory contains missing or unexpected entries.");
  for (const name of ROOT_FILES) {
    const stat = await fs.lstat(path.join(root, name));
    if (stat.isSymbolicLink() || (name === "payload" ? !stat.isDirectory() : !stat.isFile())) fail("Backup structure contains a symlink or special file.");
    if (mode(stat) & 0o077) fail("Backup metadata permissions are not private.");
  }
  const content = await readSmallAsync(path.join(root, "manifest.json"));
  const storedHash = (await readSmallAsync(path.join(root, "manifest.sha256"), 128)).toString("utf8");
  if (!/^[0-9a-f]{64}\n$/.test(storedHash) || sha(content) !== storedHash.trim()) fail("Backup manifest checksum failed.");
  const manifest = decodeManifest(parseJson(content, "Backup manifest"));
  await verifyPayloadAsync(path.join(root, "payload"), manifest);
  return { root, manifest, manifestSha256: sha(content) };
}
function summary(verified: VerifiedBackup) {
  return {
    protocolVersion: 1 as const, backupPath: verified.root, sourceDataDir: verified.manifest.sourceDataDir,
    manifestSha256: verified.manifestSha256, fileCount: verified.manifest.fileCount,
    totalBytes: verified.manifest.totalBytes, exclusions: verified.manifest.exclusions,
    externalReferences: verified.manifest.externalReferences,
  };
}
export async function verifyDataBackupAsync(backupPath: string) {
  return { ...summary(await verifyInternalAsync(backupPath)), status: "verified" as const };
}

export async function createDataBackupAsync(dataDir: string, backupPath: string) {
  const root = await requireDirectoryAsync(dataDir, "Source data directory");
  const destination = await requireAbsentAsync(backupPath, "Backup destination");
  if (within(root, destination)) fail("Backup destination must be outside the source data directory.");
  const lock = await acquireDataLockAsync(root, "migration");
  let stage: string | undefined;
  try {
    const coverage = await coverageAsync(root);
    const tree = await scanAsync(root, true);
    await createParentsAsync(path.dirname(destination));
    stage = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${crypto.randomUUID()}`);
    await fs.mkdir(stage, { mode: 0o700 });
    const payload = path.join(stage, "payload");
    await fs.mkdir(payload, { mode: 0o700 });
    const entries: Entry[] = [];
    const sqliteDatabases: string[] = [];
    for (const item of tree.entries) {
      const target = path.join(payload, item.path);
      if (item.type === "directory") {
        await fs.mkdir(target, { mode: 0o700 });
        entries.push({ path: item.path, type: "directory", mode: mode(item.stat) });
      } else {
        const hash = await hashFileAsync(path.join(root, item.path), item.stat, target);
        entries.push({ path: item.path, type: "file", mode: mode(item.stat), size: hash.size, sha256: hash.sha256 });
        if (isSqlite(item.path, hash)) sqliteDatabases.push(item.path);
      }
    }
    const config = entries.find(entry => entry.path === "config.yaml");
    if (!config || config.type !== "file" || config.sha256 !== coverage.configSha256) fail("Configuration changed after coverage was checked. Stop every writer and retry.");
    const schema = entries.some(entry => entry.path === SCHEMA_FILE)
      ? parseJson(await readSmallAsync(path.join(payload, SCHEMA_FILE)), "Data schema") : null;
    const { configSha256: _configSha256, ...publicCoverage } = coverage;
    const manifest: Manifest = {
      ...publicCoverage, formatVersion: 1, status: "complete", createdAt: new Date().toISOString(),
      rootMode: mode(tree.root), dataSchema: schema, ...counts(entries), entries, sqliteDatabases,
    };
    const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
    await writePrivateAsync(path.join(stage, "manifest.json"), manifestContent);
    await writePrivateAsync(path.join(stage, "manifest.sha256"), sha(manifestContent) + "\n");
    for (const item of [...entries].reverse()) if (item.type === "directory") await syncDirAsync(path.join(payload, item.path));
    await syncDirAsync(payload);
    await syncDirAsync(stage);
    await verifyInternalAsync(stage);

    // Re-read the entire included source, not just mtime/size, before publishing.
    const after = await scanAsync(root, true);
    if (!sameStat(tree.root, after.root) || tree.entries.length !== after.entries.length) fail("Source tree changed during backup. Stop every writer and retry.");
    for (let index = 0; index < tree.entries.length; index++) {
      const before = tree.entries[index], current = after.entries[index], entry = entries[index];
      if (before.path !== current.path || before.type !== current.type || !sameStat(before.stat, current.stat)) fail("Source tree changed during backup. Stop every writer and retry.");
      if (entry.type === "file") {
        const hash = await hashFileAsync(path.join(root, entry.path), current.stat);
        if (hash.sha256 !== entry.sha256 || hash.size !== entry.size) fail("Source file changed during backup. Stop every writer and retry.");
      }
    }
    // Catch new/deleted files and metadata changes during the final hash pass.
    const finalTree = await scanAsync(root, true);
    if (!sameStat(tree.root, finalTree.root) || finalTree.entries.length !== tree.entries.length
      || finalTree.entries.some((item, index) => item.path !== tree.entries[index].path
        || item.type !== tree.entries[index].type || !sameStat(item.stat, tree.entries[index].stat))) {
      fail("Source tree changed during backup. Stop every writer and retry.");
    }
    await requireAbsentAsync(destination, "Backup destination");
    await atomicPublisherAsync([stage, destination]);
    stage = undefined;
    await syncDirAsync(path.dirname(destination));
    return { ...summary({ root: destination, manifest, manifestSha256: sha(manifestContent) }), status: "created" as const };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await lock.releaseAsync();
  }
}

export async function restoreDataBackupAsync(backupPath: string, destinationPath: string) {
  await atomicPublisherAsync(["--check"]);
  const verified = await verifyInternalAsync(backupPath);
  const destination = await requireAbsentAsync(destinationPath, "Restore destination");
  if (within(verified.root, destination)) fail("Restore destination must be outside the backup directory.");
  if (within(path.resolve(verified.manifest.sourceDataDir), destination)) {
    let originalExists = false;
    try { await fs.lstat(verified.manifest.sourceDataDir); originalExists = true; }
    catch (error) { if (!missing(error)) throw error; }
    if (originalExists) fail("Restore destination must be outside the existing original data directory.");
  }
  await createParentsAsync(path.dirname(destination));
  let stage: string | undefined = path.join(path.dirname(destination), `.${path.basename(destination)}.restore-${crypto.randomUUID()}`);
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    for (const entry of verified.manifest.entries) {
      const target = path.join(stage, entry.path);
      if (entry.type === "directory") await fs.mkdir(target, { mode: 0o700 });
      else {
        const copied = await hashFileAsync(path.join(verified.root, "payload", entry.path), undefined, target);
        if (copied.sha256 !== entry.sha256 || copied.size !== entry.size) fail("Backup changed while restoring. No destination was published.");
      }
    }
    await verifyPayloadAsync(stage, verified.manifest);
    // Detect a changed manifest, extra payload, or edited backup before publish.
    const rechecked = await verifyInternalAsync(verified.root);
    if (rechecked.manifestSha256 !== verified.manifestSha256) fail("Backup manifest changed while restoring.");
    for (const entry of [...verified.manifest.entries].reverse()) {
      const handle = await fs.open(path.join(stage, entry.path), entry.type === "directory" ? DIR : READ);
      try { await handle.chmod(entry.mode); await handle.sync(); } finally { await handle.close(); }
    }
    await syncDirAsync(stage);
    await requireAbsentAsync(destination, "Restore destination");
    const rootHandle = await fs.open(stage, DIR);
    try {
      await atomicPublisherAsync([stage, destination]);
      stage = undefined;
      await rootHandle.chmod(verified.manifest.rootMode);
      await rootHandle.sync();
    } finally { await rootHandle.close(); }
    await syncDirAsync(path.dirname(destination));
    return { ...summary(verified), status: "restored" as const, destination };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
