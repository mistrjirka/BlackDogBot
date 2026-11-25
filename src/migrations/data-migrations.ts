import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { configSchema } from "../shared/schemas/config.schemas.js";
import { migrateLegacyTimedTask } from "./legacy-timed-tasks.js";
import { isCompletedLegacyCronRecord } from "./legacy-cron-records.js";
import { isSafeStoredTaskId, parseLegacyCronImportLedger, type LegacyCronImportEntry, type LegacyCronImportLedger } from "./legacy-cron-imports.js";
import { acquireDataLockAsync, recoverStaleDataLockAsync } from "./data-lock.js";

export const DATA_SCHEMA_VERSION = 2;
export const DATA_SCHEMA_FILE = ".data-schema.json";
export const LEGACY_IMPORTS_FILE = ".migrations/legacy-imports.json";
const TRANSACTIONS_DIR = ".migrations/transactions";
export const RETIRED_TRANSACTIONS_DIR = ".migrations/retired-transactions";
const ID_PATTERN = /^t-[0-9]+-[0-9a-f-]{36}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SCHEMA_CONTENT = Buffer.from(JSON.stringify({
  formatVersion: 1,
  schemaVersion: DATA_SCHEMA_VERSION,
  components: { timedTasks: 1, legacyCronImports: 1 },
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
  legacyTasksToImport: number;
  recordedLegacyImports: number;
}
export interface DataMigrationOptions {
  importLegacyTasks?: boolean;
}
interface InternalPlan {
  public: DataMigrationPlan;
  changes: Change[];
  inputs: { path: string; snapshot: Snapshot | null }[];
  directories: { path: string; entries: string[] }[];
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
  return value === DATA_SCHEMA_FILE || value === LEGACY_IMPORTS_FILE || (
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
  const components = raw.components;
  const versionOne = raw.schemaVersion === 1 && isRecord(components)
    && components.timedTasks === 1 && Object.keys(components).length === 1;
  const versionTwo = raw.schemaVersion === 2 && isRecord(components)
    && components.timedTasks === 1 && components.legacyCronImports === 1
    && Object.keys(components).length === 2;
  if (!versionOne && !versionTwo) {
    return fail("Unsupported data schema. An explicit migration is required.");
  }
  return raw.schemaVersion as number;
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
    || !((raw.toVersion === 1 && (raw.fromVersion === 0 || raw.fromVersion === 1))
      || (raw.toVersion === 2 && (raw.fromVersion === 0 || raw.fromVersion === 1 || raw.fromVersion === 2)))
    || !statuses.includes(raw.status as Status) || !Array.isArray(raw.files) || raw.files.length === 0) {
    return fail(`Invalid migration journal ${id}. Keep the service stopped and inspect its backup.`, id);
  }
  const paths = new Set<string>();
  for (const file of raw.files) {
    if (!isRecord(file) || !validManagedPath(file.path) || paths.has(file.path)
      || (raw.toVersion === 1 && file.path === LEGACY_IMPORTS_FILE)
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
async function readRetiredJournalAsync(dataDir: string, id: string): Promise<Journal | null> {
  if (!ID_PATTERN.test(id)) fail("Invalid migration transaction ID.");
  const snapshot = await readSnapshotAsync(dataDir, `${RETIRED_TRANSACTIONS_DIR}/${id}/journal.json`);
  if (!snapshot) return null;
  const journal = decodeJournal(parseJson(snapshot.content, "retired migration journal"), id);
  if (journal.status !== "rolled_back") fail("Retired migration history contains an unfinished transaction. Inspect its verified backup.", id);
  return journal;
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
function olderReaderVersion(dataVersion: number): number {
  // Schema 1 is the first release with a journal reader. Earlier daemons do not
  // read this directory, but keeping it readable by schema 1 also supports them.
  return Math.max(1, dataVersion);
}
async function assertNoUnretiredHistoryAsync(dataDir: string, dataVersion: number): Promise<void> {
  const unretired = (await listJournalsAsync(dataDir)).find(journal =>
    journal.toVersion > olderReaderVersion(dataVersion) && journal.status === "rolled_back");
  if (unretired) fail("Rollback history retirement is incomplete. Keep the service stopped and run migrate:recover --offline.", unretired.id);
}

/** Preserve future-schema receipts outside the directory read by old releases. */
async function retireRolledBackHistoryAsync(dataDir: string): Promise<string[]> {
  const dataVersion = versionFromSnapshot(await readSnapshotAsync(dataDir, DATA_SCHEMA_FILE));
  const future = (await listJournalsAsync(dataDir)).filter(journal => journal.toVersion > olderReaderVersion(dataVersion));
  if (future.some(journal => journal.status !== "rolled_back")) {
    fail("Future-schema migration history is not fully rolled back. Keep the service stopped and recover the data before starting older code.");
  }
  if (!future.length) {
    // Complete directory durability after a prior process stopped just after a move.
    for (const relative of [RETIRED_TRANSACTIONS_DIR, TRANSACTIONS_DIR]) {
      const directory = await safePathAsync(dataDir, relative);
      try { await syncDirectoryAsync(directory); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    return [];
  }
  const retiredDirectory = await mkdirPrivateAsync(dataDir, RETIRED_TRANSACTIONS_DIR);
  const transactionsDirectory = await safePathAsync(dataDir, TRANSACTIONS_DIR);
  const retired: string[] = [];
  for (const journal of future) {
    const source = await safePathAsync(dataDir, `${TRANSACTIONS_DIR}/${journal.id}`);
    const destination = await safePathAsync(dataDir, `${RETIRED_TRANSACTIONS_DIR}/${journal.id}`);
    try {
      await fs.lstat(destination);
      fail("Retired migration evidence already exists for this transaction. Inspect both copies before recovery.", journal.id);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!(await fs.lstat(source)).isDirectory()) fail("Migration history directory was replaced.", journal.id);
    await fs.rename(source, destination);
    await syncDirectoryAsync(retiredDirectory);
    await syncDirectoryAsync(transactionsDirectory);
    retired.push(journal.id);
  }
  return retired;
}
async function finishRollbackHistoryAsync(dataDir: string, id?: string): Promise<string[]> {
  try { return await retireRolledBackHistoryAsync(dataDir); }
  catch (error) {
    if (error instanceof DataMigrationError) throw error;
    fail("Restored data is preserved, but rollback history retirement is incomplete. Keep the service stopped and run migrate:recover --offline.", id);
  }
}

async function assertNoPendingAsync(dataDir: string): Promise<void> {
  const pending = (await listJournalsAsync(dataDir)).find(j =>
    j.status === "prepared" || j.status === "applying" || j.status === "rolling_back");
  if (pending) fail(`Migration ${pending.id} is incomplete. Stop the service and run migrate:recover --offline.`, pending.id);
}
async function assertCommittedLedgerAsync(dataDir: string, snapshot: Snapshot): Promise<void> {
  const entries = (await listJournalsAsync(dataDir))
    .filter(journal => journal.status === "applied")
    .map(journal => journal.files.find(file => file.path === LEGACY_IMPORTS_FILE))
    .filter((file): file is JournalFile => file !== undefined);
  const latest = entries.at(-1);
  if (!latest || digest(snapshot.content) !== latest.afterSha256 || snapshot.mode !== latest.afterMode) {
    fail("Legacy import ledger does not match its committed migration history. Keep the history and restore a matching verified backup; do not rebuild the ledger.");
  }
}

async function writeJournalAsync(dataDir: string, journal: Journal): Promise<void> {
  const file = await safePathAsync(dataDir, `${TRANSACTIONS_DIR}/${journal.id}/journal.json`);
  await atomicWriteAsync(file, JSON.stringify(journal, null, 2) + "\n", 0o600);
}

function validateTaskIdentity(raw: unknown, fileName: string, relative: string): asserts raw is Record<string, unknown> & { taskId: string } {
  if (!isRecord(raw) || !isSafeStoredTaskId(raw.taskId) || fileName !== `${raw.taskId}.json`) {
    fail(`${relative} must match its stored taskId. Correct the filename or ID before upgrading.`);
  }
}
function convertTask(raw: unknown, relative: string, timezone: string): ReturnType<typeof migrateLegacyTimedTask> {
  try { return migrateLegacyTimedTask(raw, { defaultTimezone: timezone }); }
  catch (error) {
    // Converter errors contain field paths and fixed reasons, never stored values.
    fail(`${relative}: ${error instanceof Error ? error.message : "Unsupported task shape."}`);
  }
}

async function buildPlanAsync(dataDir: string, options: DataMigrationOptions = {}): Promise<InternalPlan> {
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

  const marker = await readSnapshotAsync(dataDir, DATA_SCHEMA_FILE);
  const fromVersion = versionFromSnapshot(marker);
  await assertNoUnretiredHistoryAsync(dataDir, fromVersion);
  const ledgerSnapshot = await readSnapshotAsync(dataDir, LEGACY_IMPORTS_FILE);
  if (fromVersion === 2 && !ledgerSnapshot) {
    fail("The schema 2 legacy import ledger is missing. Restore its verified backup; rebuilding it could resurrect deleted tasks.");
  }
  if (fromVersion < 2 && ledgerSnapshot) {
    fail("A legacy import ledger exists without schema 2. Recover the interrupted migration or restore matching metadata.");
  }
  let ledger: LegacyCronImportLedger = { formatVersion: 1, entries: [] };
  if (ledgerSnapshot) {
    try { ledger = parseLegacyCronImportLedger(parseJson(ledgerSnapshot.content, LEGACY_IMPORTS_FILE)); }
    catch { return fail("Invalid legacy import ledger. Restore its verified backup before upgrading."); }
    await assertCommittedLedgerAsync(dataDir, ledgerSnapshot);
  }

  const cronEntries = await directoryEntriesAsync(dataDir, "cron");
  const timedEntries = await directoryEntriesAsync(dataDir, "timed");
  const inputs: InternalPlan["inputs"] = [
    { path: "config.yaml", snapshot: configSnapshot },
    { path: DATA_SCHEMA_FILE, snapshot: marker },
    { path: LEGACY_IMPORTS_FILE, snapshot: ledgerSnapshot },
  ];
  const legacyRecords = new Map<string, { fileName: string; snapshot: Snapshot; raw: unknown }>();
  for (const fileName of cronEntries) {
    if (!fileName.endsWith(".json")) continue;
    const relative = `cron/${fileName}`;
    const snapshot = await readSnapshotAsync(dataDir, relative);
    if (!snapshot) fail(`${relative} changed while planning. Stop all writers and retry.`);
    inputs.push({ path: relative, snapshot });
    legacyRecords.set(relative, { fileName, snapshot, raw: parseJson(snapshot.content, relative) });
  }

  // A recorded import remains recorded even if the user later deletes its target.
  // Never reconstruct the ledger from files or silently accept changed sources.
  const recordedSources = new Set<string>();
  for (const entry of ledger.entries) {
    const source = legacyRecords.get(entry.source);
    if (!source || digest(source.snapshot.content) !== entry.sourceSha256) {
      fail("A recorded legacy import source is missing or changed. Restore matching source data or resolve the conflict explicitly.");
    }
    validateTaskIdentity(source.raw, source.fileName, entry.source);
    if (source.raw.taskId !== entry.taskId) fail("Legacy import ledger task identity does not match its source.");
    convertTask(source.raw, entry.source, timezone);
    recordedSources.add(entry.source);
  }

  const changes: Change[] = [];
  for (const fileName of timedEntries) {
    if (!fileName.endsWith(".json")) continue;
    const relative = `timed/${fileName}`;
    const before = await readSnapshotAsync(dataDir, relative);
    if (!before) fail(`${relative} changed while planning. Retry after stopping all writers.`);
    inputs.push({ path: relative, snapshot: before });
    const raw = parseJson(before.content, relative);
    validateTaskIdentity(raw, fileName, relative);
    const result = convertTask(raw, relative, timezone);
    if (result.migrated) {
      changes.push({ path: relative, reasons: result.changes, before,
        after: Buffer.from(JSON.stringify(result.task, null, 2) + "\n"), afterMode: before.mode });
    }
  }

  let preservedLegacyRecords = 0;
  const newImports: LegacyCronImportEntry[] = [];
  for (const [relative, source] of legacyRecords) {
    if (recordedSources.has(relative)) continue;
    if (isCompletedLegacyCronRecord(source.raw, { fileName: source.fileName, defaultTimezone: timezone })) {
      preservedLegacyRecords++;
      continue;
    }
    if (options.importLegacyTasks !== true) {
      fail("Legacy cron/*.json data requires an explicit directory/schedule migration. Review migrate:plan with --import-legacy-tasks before applying. No files were changed.");
    }
    validateTaskIdentity(source.raw, source.fileName, relative);
    const result = convertTask(source.raw, relative, timezone);
    const target = `timed/${source.fileName}`;
    if (timedEntries.includes(source.fileName) || newImports.some(entry => entry.target === target)) {
      fail(`Cannot import ${relative}: its target already exists. Resolve the duplicate task explicitly; no files were changed.`);
    }
    const targetSnapshot = await readSnapshotAsync(dataDir, target);
    if (targetSnapshot) fail(`Cannot import ${relative}: its target already exists. No files were changed.`);
    inputs.push({ path: target, snapshot: null });
    changes.push({ path: target,
      reasons: ["Import legacy task into timed/ while preserving its original cron/ file", ...result.changes],
      before: null, after: Buffer.from(JSON.stringify(result.task, null, 2) + "\n"), afterMode: source.snapshot.mode });
    newImports.push({ source: relative, sourceSha256: digest(source.snapshot.content), taskId: source.raw.taskId, target });
  }

  if (!ledgerSnapshot || newImports.length > 0) {
    const nextLedger: LegacyCronImportLedger = {
      formatVersion: 1,
      entries: [...ledger.entries, ...newImports].sort((first, second) => first.source.localeCompare(second.source)),
    };
    changes.push({ path: LEGACY_IMPORTS_FILE,
      reasons: [newImports.length > 0 ? "Record imported sources so removed tasks are never re-imported" : "Initialize the legacy import ledger"],
      before: ledgerSnapshot, after: Buffer.from(JSON.stringify(nextLedger, null, 2) + "\n"), afterMode: 0o600 });
  }
  if (fromVersion < DATA_SCHEMA_VERSION) {
    changes.push({ path: DATA_SCHEMA_FILE, reasons: ["Record data schema version 2 with legacy import tracking"],
      before: marker, after: SCHEMA_CONTENT, afterMode: 0o600 });
  }
  return {
    public: {
      protocolVersion: 1, fromVersion, toVersion: DATA_SCHEMA_VERSION,
      needsMigration: changes.length > 0,
      changes: changes.map(change => ({ path: change.path, reasons: change.reasons })),
      config: { telegramEnabled: !!config.telegram?.botToken, discordEnabled: !!config.discord?.botToken },
      timezone, scope: "timed-tasks", preservedLegacyRecords,
      legacyTasksToImport: newImports.length, recordedLegacyImports: ledger.entries.length,
    },
    changes, inputs,
    directories: [{ path: "cron", entries: cronEntries }, { path: "timed", entries: timedEntries }],
  };
}

/** Read-only. It never loads a provider, opens a database, or starts a task. */
export async function planDataMigrationAsync(dataDir: string, options: DataMigrationOptions = {}): Promise<DataMigrationPlan> {
  return (await buildPlanAsync(dataDir, options)).public;
}

async function assertSnapshotAsync(dataDir: string, relative: string, expected: Snapshot | null): Promise<void> {
  const current = await readSnapshotAsync(dataDir, relative);
  if ((current ? digest(current.content) : null) !== (expected ? digest(expected.content) : null)
    || current?.mode !== expected?.mode) {
    fail(`${relative} changed after planning. Stop all writers and retry.`);
  }
}
async function assertPlanInputsAsync(dataDir: string, plan: InternalPlan): Promise<void> {
  for (const input of plan.inputs) await assertSnapshotAsync(dataDir, input.path, input.snapshot);
  for (const directory of plan.directories) {
    const current = await directoryEntriesAsync(dataDir, directory.path);
    if (JSON.stringify(current) !== JSON.stringify(directory.entries)) {
      fail(`${directory.path}/ changed after planning. Stop all writers and retry.`);
    }
  }
}
async function ensureTimedDirectoryAsync(dataDir: string): Promise<void> {
  const directory = await safePathAsync(dataDir, "timed");
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    await syncDirectoryAsync(directory);
    await syncDirectoryAsync(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    if (!(await fs.lstat(directory)).isDirectory()) fail("The timed task path must be a directory.");
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
    await assertPlanInputsAsync(dataDir, plan);
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
    await assertPlanInputsAsync(dataDir, plan);
    for (const change of plan.changes) await assertSnapshotAsync(dataDir, change.path, change.before);
    if (plan.changes.some(change => change.path.startsWith("timed/"))) {
      await ensureTimedDirectoryAsync(dataDir);
    }
    for (const change of plan.changes) {
      await assertSnapshotAsync(dataDir, change.path, change.before);
      await atomicWriteAsync(await safePathAsync(dataDir, change.path), change.after, change.afterMode);
    }
    // Sources, configuration, and unchanged tasks must still match their plan.
    const managedPaths = new Set(plan.changes.map(change => change.path));
    for (const input of plan.inputs) {
      if (!managedPaths.has(input.path)) await assertSnapshotAsync(dataDir, input.path, input.snapshot);
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
export async function applyDataMigrationAsync(dataDir: string, options: DataMigrationOptions = {}): Promise<MigrationReceipt> {
  const lock = await acquireDataLockAsync(dataDir, "migration");
  try { return await applyUnderLockAsync(dataDir, await buildPlanAsync(dataDir, options)); }
  finally { await lock.releaseAsync(); }
}

async function rollbackUnderLockAsync(dataDir: string, id: string): Promise<MigrationReceipt> {
  const journals = await listJournalsAsync(dataDir);
  const journal = journals.find(item => item.id === id);
  if (!journal) {
    const retired = await readRetiredJournalAsync(dataDir, id);
    if (retired) {
      await finishRollbackHistoryAsync(dataDir, id);
      return { protocolVersion: 1, status: "rolled_back", transactionId: id };
    }
    fail("Migration transaction not found.");
  }
  if (journal.status === "rolled_back") {
    await finishRollbackHistoryAsync(dataDir, id);
    return { protocolVersion: 1, status: "rolled_back", transactionId: id };
  }
  // Do not restore an old task transaction into a newer, unsupported data schema.
  versionFromSnapshot(await readSnapshotAsync(dataDir, DATA_SCHEMA_FILE));
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
      try {
        await fs.unlink(destination);
        await syncDirectoryAsync(path.dirname(destination));
      } catch (error) {
        // A new task may never have been written, including its parent directory.
        if (!isMissing(error)) throw error;
      }
    }
  }
  journal.status = "rolled_back";
  await writeJournalAsync(dataDir, journal);
  // The completed receipt is durable before its directory is moved. Recovery
  // can finish retirement without replaying data restoration after interruption.
  await finishRollbackHistoryAsync(dataDir, id);
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
    if (!pending.length) {
      const retired = await finishRollbackHistoryAsync(dataDir);
      return retired.length
        ? { protocolVersion: 1, status: "rolled_back", transactionId: retired.at(-1)! }
        : { protocolVersion: 1, status: "unchanged", transactionId: null };
    }
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
    if (plan.changes.some(change => change.path !== DATA_SCHEMA_FILE
      && !(change.path === LEGACY_IMPORTS_FILE && change.before === null
        && plan.public.legacyTasksToImport === 0 && plan.public.recordedLegacyImports === 0))) {
      fail("Stored tasks require migration. Stop the service, run migrate:plan, then migrate:apply --offline before starting.");
    }
    await applyUnderLockAsync(dataDir, plan);
    return lock;
  } catch (error) {
    await lock.releaseAsync();
    throw error;
  }
}
