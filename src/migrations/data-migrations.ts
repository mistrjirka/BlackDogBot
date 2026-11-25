import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { configSchema } from "../shared/schemas/config.schemas.js";
import { migrateLegacyTimedTask } from "./legacy-timed-tasks.js";
import { isCompletedLegacyCronRecord } from "./legacy-cron-records.js";
import { acquireDataLockAsync, recoverStaleDataLockAsync } from "./data-lock.js";

export const DATA_SCHEMA_VERSION = 1;
export const DATA_SCHEMA_FILE = ".data-schema.json";
const TRANSACTIONS_DIR = ".migrations/transactions";
const ID_PATTERN = /^t-[0-9]+-[0-9a-f-]{36}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SCHEMA_CONTENT = Buffer.from(JSON.stringify({
  formatVersion: 1,
  schemaVersion: DATA_SCHEMA_VERSION,
  components: { timedTasks: 1 },
}, null, 2) + "\n");

type Status = "prepared" | "applying" | "applied" | "rolling_back" | "rolled_back";
interface Snapshot { content: Buffer; mode: number }
interface Change {
  path: string;
  reasons: string[];
  before: Snapshot | null;
  after: Buffer;
  afterMode: number;
}
interface JournalFile {
  path: string;
  beforeSha256: string | null;
  afterSha256: string;
  beforeMode: number | null;
  afterMode: number;
}
interface Journal {
  formatVersion: 1;
  id: string;
  createdAt: string;
  sequence: number;
  fromVersion: number;
  toVersion: number;
  status: Status;
  files: JournalFile[];
}
export interface DataMigrationPlan {
  protocolVersion: 1;
  fromVersion: number;
  toVersion: number;
  needsMigration: boolean;
  changes: { path: string; reasons: string[] }[];
  config: { telegramEnabled: boolean; discordEnabled: boolean };
  timezone: string;
  scope: "timed-tasks";
  preservedLegacyRecords: number;
}
interface InternalPlan {
  public: DataMigrationPlan;
  changes: Change[];
  configSnapshot: Snapshot;
}
export interface MigrationReceipt {
  protocolVersion: 1;
  status: "applied" | "unchanged" | "rolled_back";
  transactionId: string | null;
}
export class DataMigrationError extends Error {
  public transactionId?: string;
  constructor(message: string, transactionId?: string) {
    super(message);
    this.name = "DataMigrationError";
    this.transactionId = transactionId;
  }
}

function fail(message: string, transactionId?: string): never {
  throw new DataMigrationError(message, transactionId);
}
function digest(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function parseJson(content: Buffer, label: string): unknown {
  try { return JSON.parse(content.toString("utf8")) as unknown; }
  catch { return fail(`Invalid JSON in ${label}. Restore or correct the file before upgrading.`); }
}
function validManagedPath(value: unknown): value is string {
  return value === DATA_SCHEMA_FILE || (
    typeof value === "string" && /^timed\/[^/\\]+\.json$/.test(value)
    && !value.includes("\0")
  );
}

/** Refuse symlinks at every path component below the explicit data root. */
async function safePathAsync(dataDir: string, relative = ""): Promise<string> {
  if (!path.isAbsolute(dataDir)) fail("The data directory must be an absolute path.");
  if (relative && (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === ".." || p === "." || p === ""))) {
    fail("Unsafe path in migration metadata.");
  }
  const root = path.resolve(dataDir);
  const parts = relative ? relative.split("/") : [];
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail(`Migration paths must not be symlinks: ${relative || "data directory"}.`);
      if (index < parts.length - 1 && !stat.isDirectory()) fail("A migration parent path is not a directory.");
      if (index === -1 && !stat.isDirectory()) fail("The data directory is not a directory.");
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (index === -1) fail("The data directory does not exist. Use the installer for a fresh installation.");
      break;
    }
  }
  return path.join(root, relative);
}

async function readSnapshotAsync(dataDir: string, relative: string): Promise<Snapshot | null> {
  const file = await safePathAsync(dataDir, relative);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) fail(`Expected a regular file: ${relative}.`);
    return { content: await fs.readFile(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
async function syncDirectoryAsync(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWriteAsync(file: string, content: Buffer | string, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.migration-${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await syncDirectoryAsync(path.dirname(file));
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}
async function mkdirPrivateAsync(dataDir: string, relative: string): Promise<string> {
  let directory = dataDir;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    directory = await safePathAsync(dataDir, parts.slice(0, index + 1).join("/"));
    let created = false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    if (!(await fs.lstat(directory)).isDirectory()) fail("Migration metadata must be a directory.");
    await fs.chmod(directory, 0o700);
    await syncDirectoryAsync(directory);
    if (created) await syncDirectoryAsync(path.dirname(directory));
  }
  return directory;
}
function versionFromSnapshot(snapshot: Snapshot | null): number {
  if (!snapshot) return 0;
  const raw = parseJson(snapshot.content, DATA_SCHEMA_FILE);
  if (!isRecord(raw) || raw.formatVersion !== 1 || !Number.isInteger(raw.schemaVersion)) {
    return fail("Unrecognized data schema marker. Do not guess the installed data version.");
  }
  if ((raw.schemaVersion as number) > DATA_SCHEMA_VERSION) {
    return fail("This data was written by a newer release. Use a compatible release or a verified backup.");
  }
  if (raw.schemaVersion !== DATA_SCHEMA_VERSION || !isRecord(raw.components)
    || raw.components.timedTasks !== 1 || Object.keys(raw.components).some(key => key !== "timedTasks")) {
    return fail("Unsupported data schema. An explicit migration is required.");
  }
  return raw.schemaVersion;
}
async function directoryEntriesAsync(dataDir: string, relative: string): Promise<string[]> {
  const directory = await safePathAsync(dataDir, relative);
  try {
    if (!(await fs.lstat(directory)).isDirectory()) fail(`Expected a directory: ${relative}.`);
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
function decodeJournal(raw: unknown, id: string): Journal {
  const statuses: Status[] = ["prepared", "applying", "applied", "rolling_back", "rolled_back"];
  if (!isRecord(raw) || raw.formatVersion !== 1 || raw.id !== id
    || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
    || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1
    || !Number.isInteger(raw.fromVersion) || !Number.isInteger(raw.toVersion)
    || (raw.fromVersion !== 0 && raw.fromVersion !== 1) || raw.toVersion !== 1
    || !statuses.includes(raw.status as Status) || !Array.isArray(raw.files) || raw.files.length === 0) {
    return fail(`Invalid migration journal ${id}. Keep the service stopped and inspect its backup.`, id);
  }
  const paths = new Set<string>();
  for (const file of raw.files) {
    if (!isRecord(file) || !validManagedPath(file.path) || paths.has(file.path)
      || (file.beforeSha256 !== null && (typeof file.beforeSha256 !== "string" || !HASH_PATTERN.test(file.beforeSha256)))
      || typeof file.afterSha256 !== "string" || !HASH_PATTERN.test(file.afterSha256)
      || !Number.isInteger(file.afterMode) || (file.afterMode as number) < 0 || (file.afterMode as number) > 0o777
      || (file.beforeSha256 === null ? file.beforeMode !== null
        : !Number.isInteger(file.beforeMode) || (file.beforeMode as number) < 0 || (file.beforeMode as number) > 0o777)) {
      return fail(`Invalid file entry in migration journal ${id}.`, id);
    }
    paths.add(file.path);
  }
  return raw as unknown as Journal;
}
async function readJournalAsync(dataDir: string, id: string): Promise<Journal> {
  if (!ID_PATTERN.test(id)) fail("Invalid migration transaction ID.");
  const snapshot = await readSnapshotAsync(dataDir, `${TRANSACTIONS_DIR}/${id}/journal.json`);
  if (!snapshot) fail(`Migration journal missing for ${id}.`, id);
  return decodeJournal(parseJson(snapshot.content, "migration journal"), id);
}
async function listJournalsAsync(dataDir: string): Promise<Journal[]> {
  const entries = await directoryEntriesAsync(dataDir, TRANSACTIONS_DIR);
  const journals: Journal[] = [];
  for (const entry of entries) {
    // Staging is published only after all originals and the journal are durable.
    if (entry.startsWith(".staging-")) continue;
    if (!ID_PATTERN.test(entry)) fail("Unrecognized transaction directory. Inspect migration metadata before upgrading.");
    journals.push(await readJournalAsync(dataDir, entry));
  }
  if (new Set(journals.map(journal => journal.sequence)).size !== journals.length) {
    fail("Duplicate migration sequence numbers. Inspect migration metadata before upgrading.");
  }
  return journals.sort((a, b) => a.sequence - b.sequence);
}
async function assertNoPendingAsync(dataDir: string): Promise<void> {
  const pending = (await listJournalsAsync(dataDir)).find(j =>
    j.status === "prepared" || j.status === "applying" || j.status === "rolling_back");
  if (pending) fail(`Migration ${pending.id} is incomplete. Stop the service and run migrate:recover --offline.`, pending.id);
}
async function writeJournalAsync(dataDir: string, journal: Journal): Promise<void> {
  const file = await safePathAsync(dataDir, `${TRANSACTIONS_DIR}/${journal.id}/journal.json`);
  await atomicWriteAsync(file, JSON.stringify(journal, null, 2) + "\n", 0o600);
}

async function buildPlanAsync(dataDir: string): Promise<InternalPlan> {
  await safePathAsync(dataDir);
  await assertNoPendingAsync(dataDir);
  const configSnapshot = await readSnapshotAsync(dataDir, "config.yaml");
  if (!configSnapshot) fail("config.yaml is missing. Use the installer for a fresh installation.");
  let rawConfig: unknown;
  try { rawConfig = parseYaml(configSnapshot.content.toString("utf8")); }
  catch { return fail("config.yaml is not valid YAML. Correct it before upgrading."); }
  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join(".")))].join(", ");
    fail(`config.yaml is incompatible at: ${fields}. No data was changed.`);
  }
  const config = parsed.data;
  const timezone = config.scheduler.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); }
  catch { return fail("scheduler.timezone is not supported by this runtime."); }

  // Earlier releases used cron/. Retain provably completed one-time records,
  // but never silently drop or activate unresolved jobs during a directory move.
  let preservedLegacyRecords = 0;
  for (const entry of await directoryEntriesAsync(dataDir, "cron")) {
    if (!entry.endsWith(".json")) continue;
    const relative = `cron/${entry}`;
    const record = await readSnapshotAsync(dataDir, relative);
    if (!record || !isCompletedLegacyCronRecord(parseJson(record.content, relative), {
      fileName: entry, defaultTimezone: timezone,
    })) {
      fail("Legacy cron/*.json data requires an explicit directory/schedule migration. No files were changed.");
    }
    preservedLegacyRecords++;
  }
  const marker = await readSnapshotAsync(dataDir, DATA_SCHEMA_FILE);
  const fromVersion = versionFromSnapshot(marker);
  const changes: Change[] = [];
  for (const entry of await directoryEntriesAsync(dataDir, "timed")) {
    if (!entry.endsWith(".json")) continue;
    const relative = `timed/${entry}`;
    const before = await readSnapshotAsync(dataDir, relative);
    if (!before) fail(`${relative} changed while planning. Retry after stopping all writers.`);
    const raw = parseJson(before.content, relative);
    if (!isRecord(raw) || typeof raw.taskId !== "string" || raw.taskId === "." || raw.taskId === ".."
      || raw.taskId.includes("/") || raw.taskId.includes("\\") || entry !== `${raw.taskId}.json`) {
      fail(`${relative} must match its stored taskId. Correct the filename or ID before upgrading.`);
    }
    let result;
    try { result = migrateLegacyTimedTask(raw, { defaultTimezone: timezone }); }
    catch (error) {
      // The converter reports field names and fixed reasons, never task content.
      const reason = error instanceof Error ? error.message : "Unsupported task shape.";
      fail(`${relative}: ${reason}`);
    }
    if (result.migrated) {
      changes.push({ path: relative, reasons: result.changes, before,
        after: Buffer.from(JSON.stringify(result.task, null, 2) + "\n"), afterMode: before.mode });
    }
  }
  if (fromVersion < DATA_SCHEMA_VERSION) {
    changes.push({ path: DATA_SCHEMA_FILE, reasons: ["Record managed timed-task schema version 1"],
      before: marker, after: SCHEMA_CONTENT, afterMode: 0o600 });
  }
  return {
    public: {
      protocolVersion: 1, fromVersion, toVersion: DATA_SCHEMA_VERSION,
      needsMigration: changes.length > 0,
      changes: changes.map(change => ({ path: change.path, reasons: change.reasons })),
      config: { telegramEnabled: !!config.telegram?.botToken, discordEnabled: !!config.discord?.botToken },
      timezone, scope: "timed-tasks", preservedLegacyRecords,
    },
    changes, configSnapshot,
  };
}

/** Read-only. It never loads a provider, opens a database, or starts a task. */
export async function planDataMigrationAsync(dataDir: string): Promise<DataMigrationPlan> {
  return (await buildPlanAsync(dataDir)).public;
}

async function assertSnapshotAsync(dataDir: string, relative: string, expected: Snapshot | null): Promise<void> {
  const current = await readSnapshotAsync(dataDir, relative);
  if ((current ? digest(current.content) : null) !== (expected ? digest(expected.content) : null)
    || current?.mode !== expected?.mode) {
    fail(`${relative} changed after planning. Stop all writers and retry.`);
  }
}
async function applyUnderLockAsync(dataDir: string, plan: InternalPlan): Promise<MigrationReceipt> {
  if (plan.changes.length === 0) return { protocolVersion: 1, status: "unchanged", transactionId: null };
  const id = `t-${Date.now()}-${crypto.randomUUID()}`;
  const transactions = await mkdirPrivateAsync(dataDir, TRANSACTIONS_DIR);
  const staging = path.join(transactions, `.staging-${id}`);
  const destination = path.join(transactions, id);
  await fs.mkdir(staging, { mode: 0o700 });
  const sequence = Math.max(0, ...(await listJournalsAsync(dataDir)).map(journal => journal.sequence)) + 1;
  const journal: Journal = {
    sequence, formatVersion: 1, id, createdAt: new Date().toISOString(),
    fromVersion: plan.public.fromVersion, toVersion: plan.public.toVersion, status: "prepared",
    files: plan.changes.map(change => ({
      path: change.path, beforeSha256: change.before ? digest(change.before.content) : null,
      afterSha256: digest(change.after), beforeMode: change.before?.mode ?? null, afterMode: change.afterMode,
    })),
  };
  let published = false;
  try {
    await assertSnapshotAsync(dataDir, "config.yaml", plan.configSnapshot);
    for (let index = 0; index < plan.changes.length; index++) {
      const change = plan.changes[index];
      await assertSnapshotAsync(dataDir, change.path, change.before);
      const name = String(index).padStart(4, "0");
      if (change.before) await atomicWriteAsync(path.join(staging, `${name}.before`), change.before.content, 0o600);
      await atomicWriteAsync(path.join(staging, `${name}.after`), change.after, 0o600);
    }
    await atomicWriteAsync(path.join(staging, "journal.json"), JSON.stringify(journal, null, 2) + "\n", 0o600);
    await syncDirectoryAsync(staging);
    await fs.rename(staging, destination);
    published = true;
    await syncDirectoryAsync(transactions);
    journal.status = "applying";
    await writeJournalAsync(dataDir, journal);
    // Check the entire input again before the first mutation.
    await assertSnapshotAsync(dataDir, "config.yaml", plan.configSnapshot);
    for (const change of plan.changes) await assertSnapshotAsync(dataDir, change.path, change.before);
    for (const change of plan.changes) {
      await assertSnapshotAsync(dataDir, change.path, change.before);
      await atomicWriteAsync(await safePathAsync(dataDir, change.path), change.after, change.afterMode);
    }
    journal.status = "applied";
    await writeJournalAsync(dataDir, journal);
    return { protocolVersion: 1, status: "applied", transactionId: id };
  } catch (error) {
    if (!published) await fs.rm(staging, { recursive: true, force: true });
    if (error instanceof DataMigrationError) {
      error.transactionId = published ? id : undefined;
      throw error;
    }
    fail(`Migration failed (${(error as NodeJS.ErrnoException)?.code ?? "I/O error"}). ${published ? "Keep the service stopped and run migrate:recover --offline." : "Original data is unchanged."}`, published ? id : undefined);
  }
}

/** The caller must stop legacy processes too. New daemons hold this same lock. */
export async function applyDataMigrationAsync(dataDir: string): Promise<MigrationReceipt> {
  const lock = await acquireDataLockAsync(dataDir, "migration");
  try { return await applyUnderLockAsync(dataDir, await buildPlanAsync(dataDir)); }
  finally { await lock.releaseAsync(); }
}

async function rollbackUnderLockAsync(dataDir: string, id: string): Promise<MigrationReceipt> {
  const journals = await listJournalsAsync(dataDir);
  const journal = journals.find(item => item.id === id);
  if (!journal) fail("Migration transaction not found.");
  if (journal.status === "rolled_back") return { protocolVersion: 1, status: "rolled_back", transactionId: id };
  const latest = journals.filter(item => item.status !== "rolled_back").at(-1);
  if (latest?.id !== id) fail("Rollback requires the newest remaining migration transaction first.", id);
  const originals: (Snapshot | null)[] = [];
  // Validate every backup and every live file before restoring any original.
  for (let index = 0; index < journal.files.length; index++) {
    const file = journal.files[index];
    const prefix = `${TRANSACTIONS_DIR}/${id}/${String(index).padStart(4, "0")}`;
    const after = await readSnapshotAsync(dataDir, `${prefix}.after`);
    const before = await readSnapshotAsync(dataDir, `${prefix}.before`);
    if (!after || digest(after.content) !== file.afterSha256
      || (before ? digest(before.content) : null) !== file.beforeSha256) {
      fail("Migration backup checksum failed. Keep the service stopped and preserve the backup.", id);
    }
    originals.push(before && { content: before.content, mode: file.beforeMode! });
    await assertRollbackTargetAsync(dataDir, file, id);
  }
  journal.status = "rolling_back";
  await writeJournalAsync(dataDir, journal);
  for (let index = journal.files.length - 1; index >= 0; index--) {
    const file = journal.files[index];
    await assertRollbackTargetAsync(dataDir, file, id);
    const original = originals[index];
    const destination = await safePathAsync(dataDir, file.path);
    if (original) await atomicWriteAsync(destination, original.content, original.mode);
    else {
      await fs.rm(destination, { force: true });
      await syncDirectoryAsync(path.dirname(destination));
    }
  }
  journal.status = "rolled_back";
  await writeJournalAsync(dataDir, journal);
  return { protocolVersion: 1, status: "rolled_back", transactionId: id };
}
async function assertRollbackTargetAsync(dataDir: string, file: JournalFile, id: string): Promise<void> {
  const current = await readSnapshotAsync(dataDir, file.path);
  const hash = current ? digest(current.content) : null;
  const mode = current?.mode ?? null;
  const matchesBefore = hash === file.beforeSha256 && mode === file.beforeMode;
  const matchesAfter = hash === file.afterSha256 && mode === file.afterMode;
  if (!matchesBefore && !matchesAfter) {
    fail(`${file.path} changed after migration. Automatic rollback would discard newer data, so it was refused.`, id);
  }
}
export async function rollbackDataMigrationAsync(dataDir: string, id: string): Promise<MigrationReceipt> {
  const lock = await acquireDataLockAsync(dataDir, "migration");
  try { return await rollbackUnderLockAsync(dataDir, id); }
  finally { await lock.releaseAsync(); }
}
export async function recoverDataMigrationAsync(dataDir: string): Promise<MigrationReceipt> {
  await recoverStaleDataLockAsync(dataDir);
  const lock = await acquireDataLockAsync(dataDir, "migration");
  try {
    const pending = (await listJournalsAsync(dataDir)).filter(j =>
      j.status === "prepared" || j.status === "applying" || j.status === "rolling_back");
    if (pending.length > 1) fail("Multiple interrupted transactions require manual inspection. Keep the service stopped.");
    if (!pending.length) return { protocolVersion: 1, status: "unchanged", transactionId: null };
    return await rollbackUnderLockAsync(dataDir, pending[0].id);
  } finally { await lock.releaseAsync(); }
}

/** Startup may record an already-compatible baseline, but never convert task data. */
export async function prepareRuntimeDataAsync(dataDir: string): Promise<Awaited<ReturnType<typeof acquireDataLockAsync>>> {
  const ownedLock = await acquireDataLockAsync(dataDir, "runtime");
  const onExit = (): void => ownedLock.releaseSync();
  // Register before planning or baseline writes, which can take time on disk.
  process.once("exit", onExit);
  const lock = {
    async releaseAsync(): Promise<void> {
      await ownedLock.releaseAsync();
      process.off("exit", onExit);
    },
    releaseSync(): void {
      ownedLock.releaseSync();
      process.off("exit", onExit);
    },
  };
  try {
    const plan = await buildPlanAsync(dataDir);
    if (plan.changes.some(change => change.path !== DATA_SCHEMA_FILE)) {
      fail("Stored tasks require migration. Stop the service, run migrate:plan, then migrate:apply --offline before starting.");
    }
    await applyUnderLockAsync(dataDir, plan);
    return lock;
  } catch (error) {
    await lock.releaseAsync();
    throw error;
  }
}
