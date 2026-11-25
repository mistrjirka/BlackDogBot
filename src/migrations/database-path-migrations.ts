import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, parseDocument } from "yaml";
import { connect } from "@lancedb/lancedb";
import { configSchema } from "../shared/schemas/config.schemas.js";
import { acquireDataLockAsync, recoverStaleDataLockAsync } from "./data-lock.js";
import {
  atomicPublishAsync, copyStoreAsync, DatabasePathMigrationError, decodeInventory,
  destinationInventory, ensureDirectoryAsync, fail, HASH, inspectStoreAsync, missing,
  populated, readFileAsync, record, replaceFileAsync, safePathAsync, sameStore,
  sha256, syncDirectoryAsync, verifyInventoryAsync, within, writePrivateAsync,
  type StoreEntry, type StoreSnapshot,
} from "./database-path-storage.js";
export { DatabasePathMigrationError } from "./database-path-storage.js";

export const DATABASE_PATH_TRANSACTIONS = ".migrations/database-paths";
const ID = /^p-[A-Za-z0-9_-]{1,120}$/;
const statuses = ["prepared", "copying", "publishing", "published", "applied", "rolling_back", "rolled_back"] as const;
type Status = typeof statuses[number];
export interface DatabasePathOptions { runtimeCwd?: string; sourcePath?: string }
export interface DatabasePathPlan {
  protocolVersion: 1;
  pathMigrationProtocolVersion: 1;
  needsMigration: boolean;
  configChange: boolean;
  sourcePath: string | null;
  destinationPath: string;
  sourceFileCount: number;
  sourceBytes: number;
  configSha256: string;
  candidates: { path: string; exists: boolean; populated: boolean; fileCount: number; totalBytes: number; fingerprint: string }[];
}
interface InternalPlan {
  public: DatabasePathPlan;
  before: Buffer;
  after: Buffer;
  configMode: number;
  source: StoreSnapshot | null;
  destination: StoreSnapshot;
  candidates: Map<string, StoreSnapshot>;
}
interface Journal {
  formatVersion: 1;
  id: string;
  status: Status;
  createdAt: string;
  sourcePath: string | null;
  destinationPath: string;
  copyRequired: boolean;
  beforeConfigSha256: string;
  afterConfigSha256: string;
  configMode: number;
  inventorySha256: string;
  sourceInventorySha256: string | null;
  beforeDestination: { exists: boolean; rootIdentity: string | null; mode: number | null };
  payloadIdentity: string | null;
  rollbackFrom: Status | null;
}
export interface DatabasePathReceipt {
  protocolVersion: 1;
  pathMigrationProtocolVersion: 1;
  status: "applied" | "unchanged" | "rolled_back";
  transactionId: string | null;
  sourcePath?: string | null;
  destinationPath?: string;
}
function json(content: Buffer, label: string): unknown {
  try { return JSON.parse(content.toString("utf8")); } catch { return fail(label + " is not valid JSON."); }
}
function targetFor(dataDir: string): string { return path.join(dataDir, "knowledge", "lancedb"); }
function covered(dataDir: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const full = path.resolve(candidate);
  if (!within(dataDir, full) || full === dataDir) return false;
  const first = path.relative(dataDir, full).split(path.sep)[0];
  return !["deploy", "models", "cache", "logs", ".migrations"].includes(first);
}
function validSource(dataDir: string, destination: string, source: string): void {
  if (source === dataDir || (source !== destination && (within(source, destination) || within(destination, source)))
    || within(path.join(dataDir, ".migrations"), source)) {
    fail("The selected database source overlaps runtime or migration directories. Select the database directory itself.");
  }
}
async function configAsync(dataDir: string): Promise<{ content: Buffer; mode: number; raw: Record<string, unknown> }> {
  const value = await readFileAsync(path.join(dataDir, "config.yaml"));
  if (!value) fail("config.yaml is missing. Use the installer for a fresh installation.");
  let raw: unknown;
  try { raw = parse(value.content.toString("utf8")); } catch { return fail("config.yaml is not valid YAML."); }
  if (!record(raw) || !configSchema.safeParse(raw).success) fail("config.yaml is incompatible. Correct its fields before migrating database paths.");
  return { ...value, raw };
}
function configAfter(before: Buffer, destination: string): Buffer {
  try {
    const document = parseDocument(before.toString("utf8"));
    if (document.errors.length) fail("config.yaml is not valid YAML.");
    const raw = document.toJS() as Record<string, unknown>;
    const intended = structuredClone(raw);
    if (!record(intended.knowledge)) intended.knowledge = {};
    (intended.knowledge as Record<string, unknown>).lancedbPath = destination;
    const node = document.getIn(["knowledge", "lancedbPath"], true) as { range?: number[] } | undefined;
    let result: string;
    if (node?.range) {
      result = before.toString("utf8").slice(0, node.range[0]) + JSON.stringify(destination)
        + before.toString("utf8").slice(node.range[1]);
    } else {
      document.setIn(["knowledge", "lancedbPath"], destination);
      result = document.toString();
    }
    if (!isDeepStrictEqual(parse(result), intended)) fail("The database path edit would change unrelated configuration.");
    return Buffer.from(result);
  } catch (error) {
    if (error instanceof DatabasePathMigrationError) throw error;
    return fail("The database path cannot be edited safely in this configuration.");
  }
}
async function listJournalsAsync(dataDir: string): Promise<Journal[]> {
  const directory = await safePathAsync(path.join(dataDir, DATABASE_PATH_TRANSACTIONS), true);
  let names: string[];
  try { names = (await fs.readdir(directory)).sort(); } catch (error) { if (missing(error)) return []; throw error; }
  const journals: Journal[] = [];
  for (const name of names) {
    if (name.startsWith(".staging-")) continue;
    if (!ID.test(name)) fail("Unknown database migration history requires inspection.");
    journals.push(await readJournalAsync(dataDir, name));
  }
  return journals.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function decodeJournal(raw: unknown, dataDir: string, id: string): Journal {
  if (!record(raw) || raw.formatVersion !== 1 || raw.id !== id || !ID.test(id)
    || !statuses.includes(raw.status as Status) || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
    || raw.destinationPath !== targetFor(dataDir)
    || (raw.sourcePath !== null && (typeof raw.sourcePath !== "string" || !path.isAbsolute(raw.sourcePath)))
    || typeof raw.copyRequired !== "boolean"
    || (raw.rollbackFrom !== null && (!statuses.includes(raw.rollbackFrom as Status) || ["rolling_back", "rolled_back"].includes(String(raw.rollbackFrom))))
    || (raw.status === "rolling_back" && raw.rollbackFrom === null)
    || ![raw.beforeConfigSha256, raw.afterConfigSha256, raw.inventorySha256].every(value => typeof value === "string" && HASH.test(value))
    || (raw.sourceInventorySha256 !== null && (typeof raw.sourceInventorySha256 !== "string" || !HASH.test(raw.sourceInventorySha256)))
    || !Number.isInteger(raw.configMode) || (raw.configMode as number) < 0 || (raw.configMode as number) > 0o777
    || !record(raw.beforeDestination) || typeof raw.beforeDestination.exists !== "boolean"
    || (raw.beforeDestination.rootIdentity !== null && (typeof raw.beforeDestination.rootIdentity !== "string" || !/^\d+:\d+$/.test(raw.beforeDestination.rootIdentity)))
    || (raw.beforeDestination.mode !== null && (!Number.isInteger(raw.beforeDestination.mode) || (raw.beforeDestination.mode as number) < 0 || (raw.beforeDestination.mode as number) > 0o777))
    || (raw.payloadIdentity !== null && (typeof raw.payloadIdentity !== "string" || !/^\d+:\d+$/.test(raw.payloadIdentity)))) {
    return fail("Database migration journal is incomplete or unsupported.", id);
  }
  if (raw.sourcePath) validSource(dataDir, raw.destinationPath as string, raw.sourcePath as string);
  if (raw.beforeDestination.exists !== (raw.beforeDestination.rootIdentity !== null)
    || raw.beforeDestination.exists !== (raw.beforeDestination.mode !== null)) fail("Database migration journal has invalid original-directory metadata.", id);
  return raw as unknown as Journal;
}
async function readJournalAsync(dataDir: string, id: string): Promise<Journal> {
  if (!ID.test(id)) fail("Invalid database migration transaction ID.");
  const directory = await safePathAsync(path.join(dataDir, DATABASE_PATH_TRANSACTIONS, id));
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) fail("Database migration history must remain private.", id);
  const value = await readFileAsync(path.join(directory, "journal.json"));
  if (!value) fail("Database migration journal is missing.", id);
  return decodeJournal(json(value.content, "Database migration journal"), dataDir, id);
}
async function writeJournalAsync(dataDir: string, journal: Journal): Promise<void> {
  const file = path.join(dataDir, DATABASE_PATH_TRANSACTIONS, journal.id, "journal.json");
  await replaceFileAsync(file, Buffer.from(JSON.stringify(journal, null, 2) + "\n"), 0o600);
}
async function assertNoPendingAsync(dataDir: string): Promise<void> {
  const pending = (await listJournalsAsync(dataDir)).find(journal => journal.status !== "applied" && journal.status !== "rolled_back");
  if (pending) fail("Database path migration is incomplete. Keep writers stopped and run paths-recover --offline.", pending.id);
}

/** Call before any startup service may write data or process user requests. */
export async function assertDatabasePathMigrationReadyAsync(dataDir: string): Promise<void> {
  await assertNoPendingAsync(dataDir);
  const { raw } = await configAsync(dataDir);
  const knowledge = record(raw.knowledge) ? raw.knowledge : {};
  if (knowledge.embeddingProvider && (typeof knowledge.lancedbPath !== "string" || !path.isAbsolute(knowledge.lancedbPath))) {
    fail("The stored knowledge path requires migration. Run paths-plan with the previous runtime cwd, then paths-apply --offline before startup.");
  }
}
async function buildPlanAsync(dataDir: string, options: DatabasePathOptions): Promise<InternalPlan> {
  const root = await safePathAsync(dataDir);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) fail("The selected data root is not a directory.");
  await assertNoPendingAsync(root);
  const { content, mode: configMode, raw } = await configAsync(root);
  const knowledge = record(raw.knowledge) ? raw.knowledge : {};
  const destinationPath = targetFor(root);
  const empty = (): StoreSnapshot => ({ exists: false, rootIdentity: null, entries: [], identities: [], fingerprint: sha256("[]"), fileCount: 0, totalBytes: 0 });
  function publicPlan(needsMigration: boolean, configChange: boolean, sourcePath: string | null,
    source: StoreSnapshot | null, candidates: Map<string, StoreSnapshot>): DatabasePathPlan {
    return {
      protocolVersion: 1, pathMigrationProtocolVersion: 1, needsMigration, configChange, sourcePath,
      destinationPath, sourceFileCount: source?.fileCount ?? 0, sourceBytes: source?.totalBytes ?? 0,
      configSha256: sha256(content), candidates: [...candidates].map(([candidate, store]) => ({
        path: candidate, exists: store.exists, populated: populated(store), fileCount: store.fileCount,
        totalBytes: store.totalBytes, fingerprint: store.fingerprint,
      })),
    };
  }
  if (!knowledge.embeddingProvider) {
    if (options.sourcePath) fail("Database source selection requires an active knowledge provider.");
    return { public: publicPlan(false, false, null, null, new Map()), before: content, after: content, configMode, source: null, destination: empty(), candidates: new Map() };
  }
  const configured = typeof knowledge.lancedbPath === "string" ? knowledge.lancedbPath : "~/.blackdogbot/knowledge/lancedb";
  if (!configured.trim()) fail("knowledge.lancedbPath is empty. Select its actual database source explicitly.");
  if (covered(root, configured)) {
    const configuredPath = await safePathAsync(path.resolve(configured), true);
    if (options.sourcePath && path.resolve(options.sourcePath) !== configuredPath) {
      const previous = (await listJournalsAsync(root)).filter(item => item.status === "applied").at(-1);
      if (!previous || previous.sourcePath !== path.resolve(options.sourcePath) || previous.destinationPath !== configuredPath) {
        fail("The database already uses a covered absolute path. A different explicit source would replace existing state.");
      }
      // Repeating the exact completed source selection never recopies old data,
      // including after the canonical database has accepted newer records.
    }
    return { public: { ...publicPlan(false, false, configuredPath, null, new Map()), destinationPath: configuredPath },
      before: content, after: content, configMode, source: null, destination: empty(), candidates: new Map() };
  }
  if (!path.isAbsolute(configured) && !options.runtimeCwd && !options.sourcePath) {
    fail("A relative or omitted legacy database path requires --runtime-cwd from the previous service, or an explicit --source.");
  }
  const candidates = new Map<string, StoreSnapshot>();
  const locations = new Set<string>([destinationPath]);
  if (path.isAbsolute(configured)) locations.add(path.resolve(configured));
  else if (options.runtimeCwd) {
    const cwd = await safePathAsync(options.runtimeCwd);
    if (!(await fs.lstat(cwd)).isDirectory()) fail("--runtime-cwd must identify a real directory.");
    locations.add(path.resolve(cwd, configured));
  }
  if (configured === "~" || configured.startsWith("~/")) {
    locations.add(path.resolve(os.homedir(), configured === "~" ? "" : configured.slice(2)));
    if (["~/.blackdogbot/knowledge/lancedb", "~/.betterclaw/knowledge/lancedb"].includes(configured)) {
      locations.add(path.join(os.homedir(), ".betterclaw", "knowledge", "lancedb"));
      locations.add(path.join(os.homedir(), ".blackdogbot", "knowledge", "lancedb"));
    }
  }
  let selected = options.sourcePath ? await safePathAsync(options.sourcePath) : null;
  if (selected) locations.add(selected);
  for (const candidate of [...locations].sort()) {
    validSource(root, destinationPath, candidate);
    const store = await inspectStoreAsync(candidate);
    if (populated(store)) {
      const top = store.entries.filter(entry => entry.path && !entry.path.includes("/"));
      if (!top.length || top.some(entry => entry.type !== "directory" || !entry.path.endsWith(".lance"))) {
        fail("A candidate is not a recognizable LanceDB directory. Inspect the database source before upgrading.");
      }
    }
    candidates.set(candidate, store);
  }
  if (selected && !candidates.get(selected)?.exists) fail("The explicitly selected database source does not exist.");
  const occupied = [...candidates].filter(([, store]) => populated(store));
  if (!selected) {
    if (occupied.length > 1) {
      const first = occupied[0][1];
      if (occupied.some(([, store]) => store.fingerprint !== first.fingerprint)) {
        throw new DatabasePathMigrationError(
          "Multiple populated database stores conflict. Review databasePathCandidates and select --source explicitly. No stores were merged.",
          undefined,
          [...candidates].map(([candidate, store]) => ({ path: candidate, exists: store.exists, populated: populated(store),
            fileCount: store.fileCount, totalBytes: store.totalBytes, fingerprint: store.fingerprint })),
        );
      }
    }
    selected = occupied.find(([candidate]) => candidate === destinationPath)?.[0] ?? occupied[0]?.[0]
      ?? [...candidates].find(([candidate, store]) => candidate === destinationPath && store.exists)?.[0]
      ?? [...candidates].find(([, store]) => store.exists)?.[0] ?? null;
  }
  const destination = candidates.get(destinationPath)!;
  const source = selected ? candidates.get(selected)! : null;
  if (populated(destination) && selected !== destinationPath) {
    if (source && source.fingerprint === destination.fingerprint) selected = destinationPath;
    else fail("The destination database already contains different data. It will not be replaced or merged.");
  }
  await atomicPublishAsync();
  const chosen = selected ? candidates.get(selected)! : null;
  const after = configAfter(content, destinationPath);
  return { public: publicPlan(true, !content.equals(after), selected, chosen, candidates),
    before: content, after, configMode, source: chosen, destination, candidates };
}
export async function planDatabasePathMigrationAsync(dataDir: string, options: DatabasePathOptions = {}): Promise<DatabasePathPlan> {
  return (await buildPlanAsync(dataDir, options)).public;
}
async function assertInputsAsync(dataDir: string, plan: InternalPlan): Promise<void> {
  const config = await readFileAsync(path.join(dataDir, "config.yaml"));
  if (!config || sha256(config.content) !== sha256(plan.before) || config.mode !== plan.configMode) fail("Configuration changed after database migration planning.");
  for (const [candidate, original] of plan.candidates) {
    if (!sameStore(original, await inspectStoreAsync(candidate), true)) fail("A database source or destination changed after planning. Stop every writer and retry.");
  }
}
async function validateLanceAsync(directory: string): Promise<void> {
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    connection = await connect(directory);
    const tables = await connection.tableNames();
    for (const name of tables) {
      const table = await connection.openTable(name);
      try {
        const schema = await table.schema();
        const names = new Set(schema.fields.map(field => field.name));
        const vector = schema.fields.find(field => field.name === "vector")?.type as unknown as { listSize?: number } | undefined;
        if (!["id", "content", "collection", "vector", "metadata", "createdAt", "updatedAt"].every(field => names.has(field))
          || !Number.isSafeInteger(vector?.listSize) || (vector?.listSize ?? 0) < 1) fail("The selected database has an unsupported record schema.");
        const expectedRows = await table.countRows();
        let rows = 0;
        // Streaming reads decode every active data fragment, including vectors.
        // Manifest row counts alone cannot detect a corrupt data file.
        for await (const batch of table.query()) {
          rows += batch.numRows;
          if (!Number.isSafeInteger(rows)) fail("The staged database has an unsupported row count.");
        }
        if (rows !== expectedRows) fail("The staged database row count changed during validation.");
      } finally { table.close(); }
    }
  } catch (error) {
    if (error instanceof DatabasePathMigrationError) throw error;
    fail("The staged database failed its read-only LanceDB validation. The original store is unchanged.");
  } finally { connection?.close(); }
}
async function makeJournalAsync(dataDir: string, plan: InternalPlan): Promise<Journal> {
  await ensureDirectoryAsync(path.join(dataDir, DATABASE_PATH_TRANSACTIONS), true);
  const id = "p-" + Date.now() + "-" + crypto.randomUUID();
  const directory = path.join(dataDir, DATABASE_PATH_TRANSACTIONS, id);
  const stage = path.join(dataDir, DATABASE_PATH_TRANSACTIONS, ".staging-" + id);
  await fs.mkdir(stage, { mode: 0o700 });
  const copyRequired = plan.public.sourcePath !== plan.public.destinationPath;
  const inventory = copyRequired ? destinationInventory(plan.source) : plan.source!.entries;
  const inventoryBytes = Buffer.from(JSON.stringify(inventory) + "\n");
  const sourceBytes = plan.source ? Buffer.from(JSON.stringify(plan.source.entries) + "\n") : null;
  const journal: Journal = {
    formatVersion: 1, id, status: "prepared", createdAt: new Date().toISOString(),
    sourcePath: plan.public.sourcePath, destinationPath: plan.public.destinationPath, copyRequired,
    beforeConfigSha256: sha256(plan.before), afterConfigSha256: sha256(plan.after), configMode: plan.configMode,
    inventorySha256: sha256(inventoryBytes), sourceInventorySha256: sourceBytes ? sha256(sourceBytes) : null,
    beforeDestination: { exists: plan.destination.exists, rootIdentity: plan.destination.rootIdentity, mode: plan.destination.exists ? plan.destination.entries[0].mode : null },
    payloadIdentity: null, rollbackFrom: null,
  };
  await writePrivateAsync(path.join(stage, "config.before"), plan.before);
  await writePrivateAsync(path.join(stage, "config.after"), plan.after);
  await writePrivateAsync(path.join(stage, "inventory.json"), inventoryBytes);
  if (sourceBytes) await writePrivateAsync(path.join(stage, "source-inventory.json"), sourceBytes);
  await writePrivateAsync(path.join(stage, "journal.json"), JSON.stringify(journal, null, 2) + "\n");
  await syncDirectoryAsync(stage);
  await atomicPublishAsync(stage, directory);
  return journal;
}
export async function applyDatabasePathMigrationAsync(dataDir: string, options: DatabasePathOptions = {}): Promise<DatabasePathReceipt> {
  const root = await safePathAsync(dataDir);
  const lock = await acquireDataLockAsync(root, "migration");
  let journal: Journal | undefined;
  try {
    const plan = await buildPlanAsync(root, options);
    if (!plan.public.needsMigration) return { protocolVersion: 1, pathMigrationProtocolVersion: 1, status: "unchanged", transactionId: null };
    journal = await makeJournalAsync(root, plan);
    const directory = path.join(root, DATABASE_PATH_TRANSACTIONS, journal.id);
    await assertInputsAsync(root, plan);
    if (journal.copyRequired) {
      journal.status = "copying";
      await writeJournalAsync(root, journal);
      const payload = path.join(directory, "payload");
      await copyStoreAsync(journal.sourcePath, plan.source, payload);
      const expected = destinationInventory(plan.source);
      await verifyInventoryAsync(payload, expected);
      await validateLanceAsync(payload);
      const copied = await verifyInventoryAsync(payload, expected);
      await assertInputsAsync(root, plan);
      journal.payloadIdentity = copied.rootIdentity;
      journal.status = "publishing";
      await writeJournalAsync(root, journal);
      await ensureDirectoryAsync(path.dirname(journal.destinationPath));
      if (plan.destination.exists) {
        const existing = await inspectStoreAsync(journal.destinationPath);
        if (!sameStore(existing, plan.destination, true) || populated(existing)) fail("The destination is no longer the verified empty directory.");
        await atomicPublishAsync(journal.destinationPath, path.join(directory, "original-empty"));
      }
      await atomicPublishAsync(payload, journal.destinationPath);
      journal.status = "published";
      await writeJournalAsync(root, journal);
    } else {
      // Native database validation opens only a private copy, never the source.
      const validation = path.join(directory, "validation");
      await copyStoreAsync(journal.destinationPath, plan.source, validation);
      const expected = destinationInventory(plan.source);
      await verifyInventoryAsync(validation, expected);
      await validateLanceAsync(validation);
      await verifyInventoryAsync(validation, expected);
      await assertInputsAsync(root, plan);
      // This verified copy is disposable. Rollback needs only the unchanged
      // canonical store and its inventory, so successful snapshots need no duplicate.
      await fs.rm(validation, { recursive: true });
      await syncDirectoryAsync(directory);
    }
    const config = await readFileAsync(path.join(root, "config.yaml"));
    if (!config || sha256(config.content) !== journal.beforeConfigSha256 || config.mode !== journal.configMode) fail("Configuration changed before the database path replacement.");
    await replaceFileAsync(path.join(root, "config.yaml"), plan.after, journal.configMode);
    journal.status = "applied";
    await writeJournalAsync(root, journal);
    return { protocolVersion: 1, pathMigrationProtocolVersion: 1, status: "applied", transactionId: journal.id, sourcePath: journal.sourcePath, destinationPath: journal.destinationPath };
  } catch (error) {
    if (error instanceof DatabasePathMigrationError) throw new DatabasePathMigrationError(error.message, journal?.id ?? error.transactionId, error.candidates);
    if (journal) fail("Database path migration stopped. Keep writers stopped and run paths-recover --offline before restarting.", journal.id);
    throw error;
  } finally { await lock.releaseAsync(); }
}
async function backupsAsync(dataDir: string, journal: Journal): Promise<{ before: Buffer; after: Buffer; inventory: StoreEntry[]; source: StoreEntry[] | null }> {
  const directory = path.join(dataDir, DATABASE_PATH_TRANSACTIONS, journal.id);
  const before = await readFileAsync(path.join(directory, "config.before"));
  const after = await readFileAsync(path.join(directory, "config.after"));
  const inventory = await readFileAsync(path.join(directory, "inventory.json"), 64 * 1024 * 1024);
  const source = await readFileAsync(path.join(directory, "source-inventory.json"), 64 * 1024 * 1024);
  if (!before || !after || !inventory || sha256(before.content) !== journal.beforeConfigSha256
    || sha256(after.content) !== journal.afterConfigSha256 || sha256(inventory.content) !== journal.inventorySha256
    || (source ? sha256(source.content) : null) !== journal.sourceInventorySha256) {
    fail("Database migration backup checksum failed. Preserve the originals and journal.", journal.id);
  }
  return { before: before.content, after: after.content,
    inventory: decodeInventory(json(inventory.content, "Database inventory")),
    source: source ? decodeInventory(json(source.content, "Source database inventory")) : null };
}
async function rollbackUnderLockAsync(dataDir: string, id: string): Promise<DatabasePathReceipt> {
  const journals = await listJournalsAsync(dataDir);
  const journal = journals.find(item => item.id === id);
  if (!journal) fail("Database migration transaction was not found.", id);
  const receipt: DatabasePathReceipt = { protocolVersion: 1, pathMigrationProtocolVersion: 1, status: "rolled_back", transactionId: id };
  if (journal.status === "rolled_back") return receipt;
  if (journals.filter(item => item.status !== "rolled_back").at(-1)?.id !== id) fail("Roll back the newest remaining database path transaction first.", id);
  const backup = await backupsAsync(dataDir, journal);
  const config = await readFileAsync(path.join(dataDir, "config.yaml"));
  const configHash = config ? sha256(config.content) : null;
  if (!config || config.mode !== journal.configMode || ![journal.beforeConfigSha256, journal.afterConfigSha256].includes(configHash!)) {
    fail("Configuration changed after path migration. Automatic rollback would overwrite newer settings, so it was refused.", id);
  }
  if (journal.sourcePath && journal.sourcePath !== journal.destinationPath && backup.source) await verifyInventoryAsync(journal.sourcePath, backup.source);
  const directory = path.join(dataDir, DATABASE_PATH_TRANSACTIONS, id);
  const retained = path.join(directory, "retained-data");
  const originalDirectory = path.join(directory, "original-empty");
  const live = await inspectStoreAsync(journal.destinationPath);
  const stored = await inspectStoreAsync(retained);
  const original = await inspectStoreAsync(originalDirectory);
  const unchangedOriginal = (store: StoreSnapshot): boolean => store.exists && !populated(store)
    && store.rootIdentity === journal.beforeDestination.rootIdentity
    && store.entries[0].mode === journal.beforeDestination.mode;
  if (original.exists && !unchangedOriginal(original)) fail("The preserved original database directory changed.", id);
  const ownsLive = journal.copyRequired && live.exists && live.rootIdentity === journal.payloadIdentity;
  const ownsStored = journal.copyRequired && stored.exists && stored.rootIdentity === journal.payloadIdentity;
  const beforeRollback = journal.rollbackFrom ?? journal.status;
  if (!journal.copyRequired) await verifyInventoryAsync(journal.destinationPath, backup.inventory);
  else if (ownsLive) {
    await verifyInventoryAsync(journal.destinationPath, backup.inventory);
    if (stored.exists) fail("Retained database evidence already exists. Inspect both copies before recovery.", id);
  } else if (ownsStored) {
    await verifyInventoryAsync(retained, backup.inventory);
    if (live.exists && !unchangedOriginal(live)) fail("The restored database destination contains newer data or permissions.", id);
  } else {
    // Before publication, the empty original remains live or in the journal.
    if (["published", "applied"].includes(beforeRollback)
      || (live.exists && !unchangedOriginal(live))
      || (journal.beforeDestination.exists && !live.exists && !original.exists)
      || stored.exists) {
      fail("Database directory ownership changed. Preserve both stores before recovery.", id);
    }
  }
  if (journal.copyRequired && journal.beforeDestination.exists && !original.exists && !unchangedOriginal(live)) {
    fail("The preserved original database directory is missing.", id);
  }
  journal.rollbackFrom ??= journal.status;
  journal.status = "rolling_back";
  await writeJournalAsync(dataDir, journal);
  await replaceFileAsync(path.join(dataDir, "config.yaml"), backup.before, journal.configMode);
  if (ownsLive) await atomicPublishAsync(journal.destinationPath, retained);
  if (journal.copyRequired && original.exists) await atomicPublishAsync(originalDirectory, journal.destinationPath);
  journal.status = "rolled_back";
  await writeJournalAsync(dataDir, journal);
  return receipt;
}
export async function rollbackDatabasePathMigrationAsync(dataDir: string, id: string): Promise<DatabasePathReceipt> {
  const lock = await acquireDataLockAsync(dataDir, "migration");
  try { return await rollbackUnderLockAsync(dataDir, id); } finally { await lock.releaseAsync(); }
}
export async function recoverDatabasePathMigrationAsync(dataDir: string): Promise<DatabasePathReceipt> {
  await recoverStaleDataLockAsync(dataDir);
  const lock = await acquireDataLockAsync(dataDir, "migration");
  try {
    const pending = (await listJournalsAsync(dataDir)).filter(item => item.status !== "applied" && item.status !== "rolled_back");
    if (pending.length > 1) fail("Multiple unfinished database migrations need manual inspection.");
    if (!pending.length) return { protocolVersion: 1, pathMigrationProtocolVersion: 1, status: "unchanged", transactionId: null };
    return await rollbackUnderLockAsync(dataDir, pending[0].id);
  } finally { await lock.releaseAsync(); }
}
