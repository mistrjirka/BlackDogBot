import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";
import { acquireDataLockAsync } from "../../../src/migrations/data-lock.js";
import { applyDataMigrationAsync, planDataMigrationAsync } from "../../../src/migrations/data-migrations.js";
import {
  createDataBackupAsync, DATA_BACKUP_EXCLUSIONS, DataBackupError,
  planDataBackupAsync, restoreDataBackupAsync, validateDataBackupSourceAsync,
  verifyDataBackupAsync,
} from "../../../src/migrations/data-backups.js";

let root: string;
let data: string;
let backup: string;
const databases: Database.Database[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-full-backup-"));
  data = path.join(root, "data");
  backup = path.join(root, "backups", "first");
  await writeTestConfigAsync(path.join(data, "config.yaml"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.open) db.close();
  await fs.rm(root, { recursive: true, force: true });
});
async function write(relative: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const target = path.join(data, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content);
  await fs.chmod(target, mode);
}
async function configure(update: (config: any) => void): Promise<void> {
  const target = path.join(data, "config.yaml");
  const config = parseYaml(await fs.readFile(target, "utf8"));
  update(config);
  await fs.writeFile(target, stringifyYaml(config));
}
async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function manifest(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(backup, "manifest.json"), "utf8"));
}
async function changeManifest(update: (value: any) => void): Promise<void> {
  const value = await manifest();
  update(value);
  const content = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(path.join(backup, "manifest.json"), content);
  await fs.writeFile(path.join(backup, "manifest.sha256"), crypto.createHash("sha256").update(content).digest("hex") + "\n");
}
async function snapshotTree(directory: string): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of (await fs.readdir(directory)).sort()) {
    const target = path.join(directory, entry);
    const stat = await fs.lstat(target);
    result[entry] = stat.isSymbolicLink() ? { link: await fs.readlink(target) }
      : stat.isDirectory() ? { mode: stat.mode & 0o7777, entries: await snapshotTree(target) }
      : { mode: stat.mode & 0o7777, content: (await fs.readFile(target)).toString("base64") };
  }
  return result;
}
async function expectUnpublished(): Promise<void> {
  expect(await exists(backup)).toBe(false);
  expect(await exists(path.join(data, ".migrations/lock.json"))).toBe(false);
  const parent = path.dirname(backup);
  if (await exists(parent)) expect((await fs.readdir(parent)).filter(entry => entry.includes(".staging-"))).toEqual([]);
}
function openDb(file: string): Database.Database {
  const db = new Database(file);
  databases.push(db);
  return db;
}

describe("full persistent-data backup", () => {
  it("preflights without modifying the source and explicitly lists exclusions", async () => {
    await write("sessions/first.json", '{"message":"keep"}');
    await write("models/model.bin", "large reproducible model");
    await write("logs/runtime.log", "excluded log");
    const before = await snapshotTree(data);
    const plan = await planDataBackupAsync(data);
    expect(plan.status).toBe("planned");
    expect(plan.fileCount).toBe(2);
    expect(plan.exclusions).toEqual([...DATA_BACKUP_EXCLUSIONS]);
    expect(await snapshotTree(data)).toEqual(before);
  });

  it("captures unknown persistent folders, secrets, schema, and migration history privately", async () => {
    const binary = Buffer.from([0, 255, 129, 10, 32]);
    await write("sessions/chat.json", '{"text":"private conversation"}', 0o640);
    await write("workspace/custom.bin", binary, 0o644);
    await write("uploads/document.bin", binary);
    await write("knowledge/collection/data.bin", binary);
    await write("skill-state/state.json", '{"runs":7}');
    await write("future-state/state.bin", binary);
    await write(".data-schema.json", '{"formatVersion":1,"schemaVersion":1,"components":{"timedTasks":1}}');
    await write(".migrations/transactions/t-example/journal.json", '{"status":"applied"}');
    await write(".migrations/legacy-imports/import.json", '{"preserve":"ledger"}');
    for (const relative of ["deploy/releases/source.ts", "models/weights.bin", "cache/result", "logs/output.log"]) {
      await write(relative, "intentionally excluded");
    }
    const originalConfig = await fs.readFile(path.join(data, "config.yaml"));
    const receipt = await createDataBackupAsync(data, backup);
    expect(receipt.status).toBe("created");
    expect(receipt.sourceDataDir).toBe(data);
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const value = await manifest();
    expect(value.status).toBe("complete");
    expect(value.dataSchema.schemaVersion).toBe(1);
    expect(value.entries.map((entry: any) => entry.path)).toEqual(expect.arrayContaining([
      "sessions/chat.json", "workspace/custom.bin", "uploads/document.bin",
      "knowledge/collection/data.bin", "skill-state/state.json", "future-state/state.bin",
      ".migrations/transactions/t-example/journal.json", ".migrations/legacy-imports/import.json",
    ]));
    expect(value.entries.some((entry: any) => DATA_BACKUP_EXCLUSIONS.some(exclusion => entry.path === exclusion || entry.path.startsWith(exclusion + "/")))).toBe(false);
    expect(await fs.readFile(path.join(backup, "payload/workspace/custom.bin"))).toEqual(binary);
    expect(await fs.readFile(path.join(data, "config.yaml"))).toEqual(originalConfig);
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(backup, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(backup, "payload/workspace/custom.bin"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(backup, "manifest.json"), "utf8")).not.toContain("test-only-not-a-secret");
    const beforeVerify = await snapshotTree(backup);
    expect((await verifyDataBackupAsync(backup)).status).toBe("verified");
    expect(await snapshotTree(backup)).toEqual(beforeVerify);
  });

  it("restores bytes and modes to an absent destination without editing the original", async () => {
    await fs.chmod(data, 0o750);
    await write("prompts/custom.md", "keep exact spacing\n\n", 0o640);
    await write("workspace/script", "#!/bin/sh\nexit 0\n", 0o751);
    await fs.chmod(path.join(data, "prompts"), 0o750);
    await createDataBackupAsync(data, backup);
    const original = await snapshotTree(data);
    const destination = path.join(root, "restore", "new-data");
    const receipt = await restoreDataBackupAsync(backup, destination);
    expect(receipt).toMatchObject({ status: "restored", destination, sourceDataDir: data });
    expect(await snapshotTree(destination)).toEqual(original);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o750);
    expect(await snapshotTree(data)).toEqual(original);
    expect(await exists(path.join(destination, ".migrations/lock.json"))).toBe(false);
  });

  it("retains committed SQLite WAL rows while preserving source and saved bytes", async () => {
    await fs.mkdir(path.join(data, "databases"));
    const dbPath = path.join(data, "databases", "blackdog.db");
    const db = openDb(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("CREATE TABLE messages (text TEXT NOT NULL)");
    db.prepare("INSERT INTO messages VALUES (?)").run("checkpointed");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.prepare("INSERT INTO messages VALUES (?)").run("committed-in-wal");
    expect((await fs.stat(dbPath + "-wal")).size).toBeGreaterThan(0);

    const baseOnly = path.join(root, "without-wal.db");
    await fs.copyFile(dbPath, baseOnly);
    const withoutWal = openDb(baseOnly);
    expect(withoutWal.prepare("SELECT text FROM messages").all()).toEqual([{ text: "checkpointed" }]);
    const before = await snapshotTree(path.join(data, "databases"));
    await createDataBackupAsync(data, backup);
    expect(await snapshotTree(path.join(data, "databases"))).toEqual(before);
    expect((await manifest()).sqliteDatabases).toEqual(["databases/blackdog.db"]);
    const saved = await snapshotTree(backup);

    const restoredDir = path.join(root, "restored");
    await restoreDataBackupAsync(backup, restoredDir);
    expect(await snapshotTree(backup)).toEqual(saved);
    const restored = openDb(path.join(restoredDir, "databases", "blackdog.db"));
    expect(restored.prepare("SELECT text FROM messages ORDER BY rowid").all()).toEqual([
      { text: "checkpointed" }, { text: "committed-in-wal" },
    ]);
    expect(restored.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("preserves a real import ledger without resurrecting a deleted timed task", async () => {
    const fixture = await fs.readFile(new URL("../../fixtures/migrations/legacy-imports/pending-once.json", import.meta.url));
    await write("cron/pending-once.json", fixture);
    await applyDataMigrationAsync(data, { importLegacyTasks: true });
    await fs.unlink(path.join(data, "timed/pending-once.json"));
    await createDataBackupAsync(data, backup);
    const destination = path.join(root, "restored-ledger");
    await restoreDataBackupAsync(backup, destination);

    expect(await planDataMigrationAsync(destination, { importLegacyTasks: true })).toMatchObject({
      needsMigration: false, legacyTasksToImport: 0, recordedLegacyImports: 1,
    });
    expect(await exists(path.join(destination, "timed/pending-once.json"))).toBe(false);
    expect(await fs.readFile(path.join(destination, ".migrations/legacy-imports.json")))
      .toEqual(await fs.readFile(path.join(data, ".migrations/legacy-imports.json")));
  });

  it.each(["create", "restore"])("atomically refuses an empty destination appearing after the last %s check", async action => {
    if (action === "restore") await createDataBackupAsync(data, backup);
    const destination = action === "create" ? backup : path.join(root, "raced-restore");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const lstat = fs.lstat.bind(fs);
    let absentChecks = 0;
    let reservedInode = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      try { return await lstat(...args); }
      catch (error) {
        if (String(args[0]) === destination && (error as NodeJS.ErrnoException).code === "ENOENT") {
          absentChecks++;
          // Initial and final requireAbsent each perform two checks. Create the
          // competing directory after the final check observed ENOENT.
          if (absentChecks === 4) {
            await fs.mkdir(destination);
            reservedInode = (await lstat(destination)).ino;
          }
        }
        throw error;
      }
    });
    const attempt = action === "create"
      ? createDataBackupAsync(data, destination)
      : restoreDataBackupAsync(backup, destination);
    await expect(attempt).rejects.toThrow(/Atomic publication refused/);
    expect(absentChecks).toBe(4);
    expect(reservedInode).toBeGreaterThan(0);
    expect((await lstat(destination)).ino).toBe(reservedInode);
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it("does not create a missing source directory", async () => {
    const missing = path.join(root, "missing");
    await expect(createDataBackupAsync(missing, backup)).rejects.toThrow();
    expect(await exists(missing)).toBe(false);
    expect(await exists(backup)).toBe(false);
  });

  it("refuses a backup within the source before creating a lock", async () => {
    await expect(createDataBackupAsync(data, path.join(data, "backup"))).rejects.toThrow(/outside the source/);
    expect(await exists(path.join(data, ".migrations"))).toBe(false);
  });

  it("refuses an existing backup destination and keeps its files", async () => {
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(path.join(backup, "sentinel"), "keep");
    await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/must not already exist/);
    expect(await fs.readFile(path.join(backup, "sentinel"), "utf8")).toBe("keep");
  });

  it.each(["empty", "populated"])("refuses an existing %s restore destination", async (kind) => {
    await createDataBackupAsync(data, backup);
    const destination = path.join(root, "existing");
    await fs.mkdir(destination);
    if (kind === "populated") await fs.writeFile(path.join(destination, "sentinel"), "keep");
    const original = await snapshotTree(destination);
    await expect(restoreDataBackupAsync(backup, destination)).rejects.toThrow(/must not already exist/);
    expect(await snapshotTree(destination)).toEqual(original);
  });

  it("requires absolute source, backup, and restore paths", async () => {
    await expect(createDataBackupAsync("relative", backup)).rejects.toThrow(/absolute path/);
    await expect(createDataBackupAsync(data, "relative")).rejects.toThrow(/absolute path/);
    await createDataBackupAsync(data, backup);
    await expect(verifyDataBackupAsync("relative")).rejects.toThrow(/absolute path/);
    await expect(restoreDataBackupAsync(backup, "relative")).rejects.toThrow(/absolute path/);
  });

  it("refuses an active writer and does not steal its lock", async () => {
    const lock = await acquireDataLockAsync(data, "runtime");
    try {
      await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/locked by runtime/);
      expect(await exists(path.join(data, ".migrations/lock.json"))).toBe(true);
      expect(await exists(backup)).toBe(false);
    } finally { await lock.releaseAsync(); }
  });

  it("refuses source symlinks without copying their external targets", async () => {
    const external = path.join(root, "external");
    await fs.writeFile(external, "do not copy");
    await fs.symlink(external, path.join(data, "private-link"));
    await expect(planDataBackupAsync(data)).rejects.toThrow(/symlink or special file/);
    await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/symlink or special file/);
    await expectUnpublished();
    expect(await fs.readFile(external, "utf8")).toBe("do not copy");
  });

  it("refuses symlink ancestors that disguise a nested backup", async () => {
    const alias = path.join(root, "alias");
    await fs.symlink(data, alias);
    await expect(createDataBackupAsync(data, path.join(alias, "nested"))).rejects.toThrow(/symlinks/);
    await expect(createDataBackupAsync(alias, backup)).rejects.toThrow(/symlinks/);
    expect(await exists(path.join(data, "nested"))).toBe(false);
  });

  it("refuses special files without opening them", async () => {
    const server = net.createServer();
    const socket = path.join(data, "worker.sock");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    try {
      await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/special file/);
      await expectUnpublished();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(["outside", "relative", "tilde", "excluded"])("refuses an active %s vector store before an upgrade stops the service", async kind => {
    await configure(config => {
      config.knowledge.embeddingProvider = "local";
      config.knowledge.lancedbPath = kind === "outside" ? path.join(root, "external-vectors")
        : kind === "relative" ? "relative-vectors"
        : kind === "tilde" ? "~/.blackdogbot/knowledge/lancedb"
        : path.join(data, "cache", "vectors");
    });
    await expect(validateDataBackupSourceAsync(data)).rejects.toThrow(/knowledge.lancedbPath/);
    expect(await exists(path.join(data, ".migrations"))).toBe(false);
  });

  it("rejects an active vector store hidden behind an in-root symlink during preflight", async () => {
    const outside = path.join(root, "outside-knowledge");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(data, "knowledge"));
    await configure(config => {
      config.knowledge.embeddingProvider = "local";
      config.knowledge.lancedbPath = path.join(data, "knowledge", "lancedb");
    });
    await expect(validateDataBackupSourceAsync(data)).rejects.toThrow(/symlinks/);
    expect(await exists(path.join(data, ".migrations"))).toBe(false);
  });

  it("detects files added during the final source hash pass", async () => {
    await write("workspace/data", "stable");
    const source = path.join(data, "workspace/data");
    const open = fs.open.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, permissions) => {
      const handle = await open(file, flags, permissions);
      if (String(file) === source && ++reads === 2) {
        await fs.writeFile(path.join(data, "workspace", "late-file"), "new");
      }
      return handle;
    });
    await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/tree changed/);
    expect(reads).toBe(2);
    await expectUnpublished();
  });

  it("does not reject an unused external vector-store setting", async () => {
    await configure(config => { config.knowledge.lancedbPath = path.join(root, "unused"); });
    await expect(validateDataBackupSourceAsync(data)).resolves.toMatchObject({ sourceDataDir: data });
  });

  it("refuses external profile directories that the active provider writes", async () => {
    await configure(config => { config.ai.openaiCompatible.profilesDir = path.join(root, "profiles"); });
    await expect(validateDataBackupSourceAsync(data)).rejects.toThrow(/profilesDir/);
  });

  it("checks mutable profile directories of configured fallback providers", async () => {
    await configure(config => {
      config.ai.fallbacks = [{ provider: "openrouter" }];
      config.ai.openrouter = { apiKey: "fake", model: "fake", profilesDir: path.join(root, "fallback-profiles") };
    });
    await expect(validateDataBackupSourceAsync(data)).rejects.toThrow(/openrouter.profilesDir/);
  });

  it("records external skill sources while preserving their in-root mutable state", async () => {
    const skills = path.join(root, "skill-source");
    await configure(config => { config.skills.directories = [skills]; });
    await write("skill-state/hash.json", '{"state":"ready"}');
    const receipt = await createDataBackupAsync(data, backup);
    expect(receipt.externalReferences).toEqual([
      { field: "skills.directories", configuredPath: skills, reason: "read-only skill source" },
    ]);
    expect(await fs.readFile(path.join(backup, "payload/skill-state/hash.json"), "utf8")).toContain("ready");
  });

  it.each(["edit", "add"])("does not publish if a writer can %s source data during copying", async kind => {
    await write("workspace/data", "before");
    const mkdir = fs.mkdir.bind(fs);
    let changed = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (!changed && String(args[0]).includes(".staging-") && String(args[0]).endsWith("/payload")) {
        changed = true;
        await fs.writeFile(path.join(data, "workspace", kind === "edit" ? "data" : "new"), "after");
      }
      return mkdir(...args);
    });
    await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/changed/);
    expect(changed).toBe(true);
    await expectUnpublished();
  });

  it("keeps original data and removes unpublished staging after a disk-full write", async () => {
    const original = await fs.readFile(path.join(data, "config.yaml"));
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, permissions) => {
      const handle = await open(file, flags, permissions);
      if (String(file).includes(".staging-") && String(file).endsWith("/payload/config.yaml")) {
        vi.spyOn(handle, "writeFile").mockRejectedValue(Object.assign(new Error("No space"), { code: "ENOSPC" }));
      }
      return handle;
    });
    await expect(createDataBackupAsync(data, backup)).rejects.toMatchObject({ code: "ENOSPC" });
    await expectUnpublished();
    expect(await fs.readFile(path.join(data, "config.yaml"))).toEqual(original);
  });

  it("does not publish a corrupted SQLite database even with valid file hashes", async () => {
    await write("databases/broken.db", "not a SQLite database");
    await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/SQLite integrity verification failed/);
    await expectUnpublished();
    expect(await fs.readFile(path.join(data, "databases/broken.db"), "utf8")).toBe("not a SQLite database");
  });

  it("rejects orphaned SQLite sidecars instead of silently dropping them", async () => {
    await write("databases/missing.db-wal", "orphan");
    await expect(createDataBackupAsync(data, backup)).rejects.toThrow(/orphaned SQLite/);
    await expectUnpublished();
  });
});

describe("backup verification and restore gates", () => {
  beforeEach(async () => {
    await write("sessions/test.json", '{"text":"retained"}');
    await createDataBackupAsync(data, backup);
  });

  it("rejects corrupt payload bytes before creating a restore destination", async () => {
    await fs.writeFile(path.join(backup, "payload/sessions/test.json"), "tampered");
    const destination = path.join(root, "restore");
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/checksum/);
    await expect(restoreDataBackupAsync(backup, destination)).rejects.toThrow(/checksum/);
    expect(await exists(destination)).toBe(false);
  });

  it("rejects an invalid manifest checksum", async () => {
    await fs.appendFile(path.join(backup, "manifest.json"), " ");
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/manifest checksum/);
  });

  it("rejects incomplete snapshot metadata", async () => {
    await changeManifest(value => { value.status = "copying"; });
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/incomplete or unsupported/);
  });

  it.each(["../escape", "/absolute", "sessions/../../escape", "sessions\\escape"])("rejects unsafe manifest path %s", async unsafe => {
    await changeManifest(value => { value.entries.find((entry: any) => entry.type === "file").path = unsafe; });
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/unsafe or duplicate path/);
  });

  it("rejects duplicate manifest paths", async () => {
    await changeManifest(value => { value.entries.push(value.entries[0]); });
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/duplicate path/);
  });

  it("rejects unlisted payload and root entries", async () => {
    await fs.writeFile(path.join(backup, "payload", "extra"), "unexpected", { mode: 0o600 });
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/unexpected entries/);
    await fs.unlink(path.join(backup, "payload", "extra"));
    await fs.writeFile(path.join(backup, "extra"), "unexpected");
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/unexpected entries/);
  });

  it("rejects payload symlinks even when their target has the expected bytes", async () => {
    const payload = path.join(backup, "payload/sessions/test.json");
    const external = path.join(root, "external.json");
    await fs.copyFile(payload, external);
    await fs.unlink(payload);
    await fs.symlink(external, payload);
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/symlink or special file/);
  });

  it("rejects a backup made readable to other users", async () => {
    await fs.chmod(backup, 0o755);
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/permissions are not private/);
  });

  it("does not publish a restore after a staging write fails", async () => {
    const original = await snapshotTree(data);
    const destination = path.join(root, "restore");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, permissions) => {
      const handle = await open(file, flags, permissions);
      if (String(file).includes(".restore-") && String(file).endsWith("/config.yaml")) {
        vi.spyOn(handle, "writeFile").mockRejectedValue(Object.assign(new Error("No space"), { code: "ENOSPC" }));
      }
      return handle;
    });
    await expect(restoreDataBackupAsync(backup, destination)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await exists(destination)).toBe(false);
    expect((await fs.readdir(root)).some(entry => entry.includes(".restore-"))).toBe(false);
    expect(await snapshotTree(data)).toEqual(original);
  });

  it("rejects schema metadata that differs from the captured payload", async () => {
    await changeManifest(value => { value.dataSchema = { schemaVersion: 999 }; });
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/data-schema metadata/);
  });

  it("does not restore inside the existing original data directory", async () => {
    const original = await snapshotTree(data);
    await expect(restoreDataBackupAsync(backup, path.join(data, "nested-restore"))).rejects.toThrow(/outside the existing original/);
    expect(await snapshotTree(data)).toEqual(original);
  });

  it("requires the configuration even if a manifest was rewritten to omit it", async () => {
    await changeManifest(value => {
      const config = value.entries.find((entry: any) => entry.path === "config.yaml");
      value.entries = value.entries.filter((entry: any) => entry.path !== "config.yaml");
      value.fileCount--;
      value.totalBytes -= config.size;
    });
    await fs.unlink(path.join(backup, "payload", "config.yaml"));
    await expect(verifyDataBackupAsync(backup)).rejects.toThrow(/omits the application configuration/);
  });

  it("returns a distinct safe error type for actionable CLI failures", async () => {
    await changeManifest(value => { value.status = "not-complete"; });
    await expect(verifyDataBackupAsync(backup)).rejects.toBeInstanceOf(DataBackupError);
  });
});
