import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { connect } from "@lancedb/lancedb";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";
import { configSchema } from "../../../src/shared/schemas/config.schemas.js";
import {
  applyDatabasePathMigrationAsync, assertDatabasePathMigrationReadyAsync, DATABASE_PATH_TRANSACTIONS,
  DatabasePathMigrationError, planDatabasePathMigrationAsync, recoverDatabasePathMigrationAsync,
  rollbackDatabasePathMigrationAsync,
} from "../../../src/migrations/database-path-migrations.js";
import * as storage from "../../../src/migrations/database-path-storage.js";

let root: string, dataDir: string, runtimeCwd: string, fakeHome: string, target: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-database-paths-"));
  dataDir = path.join(root, "data");
  runtimeCwd = path.join(root, "old-release");
  fakeHome = path.join(root, "home");
  target = path.join(dataDir, "knowledge", "lancedb");
  await fs.mkdir(runtimeCwd);
  await fs.mkdir(fakeHome);
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  vi.stubEnv("BLACKDOGBOT_DATA_DIR", dataDir);
  await writeTestConfigAsync(path.join(dataDir, "config.yaml"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function configure(databasePath: string | undefined, enabled = true): Promise<Buffer> {
  const file = path.join(dataDir, "config.yaml");
  const config = parse(await fs.readFile(file, "utf8"));
  config.knowledge = { ...(enabled ? { embeddingProvider: "local" } : {}),
    ...(databasePath === undefined ? {} : { lancedbPath: databasePath }) };
  await fs.writeFile(file, "# retained configuration comment\n" + stringify(config), { mode: 0o600 });
  return fs.readFile(file);
}
function record(id: string) {
  return { id, content: "synthetic retained knowledge", collection: "test", vector: [0.1, 0.2, 0.3],
    metadata: "{}", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
async function makeStore(directory: string, id = "first"): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const connection = await connect(directory);
  try {
    const table = await connection.createTable("knowledge", [record(id)]);
    table.close();
  } finally { connection.close(); }
}
async function rows(directory: string): Promise<number> {
  const connection = await connect(directory);
  try { const table = await connection.openTable("knowledge"); try { return await table.countRows(); } finally { table.close(); } }
  finally { connection.close(); }
}
async function addRow(directory: string): Promise<void> {
  const connection = await connect(directory);
  try { const table = await connection.openTable("knowledge"); try { await table.add([record("new-write")]); } finally { table.close(); } }
  finally { connection.close(); }
}
async function transactionFailure(action: () => Promise<unknown>): Promise<string> {
  try { await action(); throw new Error("Expected the operation to fail"); }
  catch (error) {
    expect(error).toBeInstanceOf(DatabasePathMigrationError);
    expect((error as DatabasePathMigrationError).transactionId).toMatch(/^p-/);
    return (error as DatabasePathMigrationError).transactionId!;
  }
}
function transaction(id: string, file: string): string { return path.join(dataDir, DATABASE_PATH_TRANSACTIONS, id, file); }

describe("database path discovery and defaults", () => {
  it("evaluates the fresh absolute default against the currently selected data root", async () => {
    const raw = parse((await configure(undefined)).toString());
    expect(configSchema.parse(raw).knowledge.lancedbPath).toBe(target);
    vi.stubEnv("BLACKDOGBOT_DATA_DIR", path.join(root, "second-data"));
    expect(configSchema.parse(raw).knowledge.lancedbPath).toBe(path.join(root, "second-data", "knowledge", "lancedb"));
    vi.stubEnv("BLACKDOGBOT_DATA_DIR", undefined);
    expect(configSchema.parse(raw).knowledge.lancedbPath).toBe(path.join(fakeHome, ".blackdogbot", "knowledge", "lancedb"));
  });

  it("keeps planning read-only and distinguishes literal runtime cwd from home expansion", async () => {
    const before = await configure("~/.betterclaw/knowledge/lancedb");
    const literal = path.join(runtimeCwd, "~", ".betterclaw", "knowledge", "lancedb");
    const homeStore = path.join(fakeHome, ".betterclaw", "knowledge", "lancedb");
    await fs.mkdir(literal, { recursive: true });
    await makeStore(homeStore);
    const sourceBefore = await storage.inspectStoreAsync(homeStore);
    const plan = await planDatabasePathMigrationAsync(dataDir, { runtimeCwd });
    expect(plan).toMatchObject({ needsMigration: true, sourcePath: homeStore, destinationPath: target, sourceFileCount: sourceBefore.fileCount });
    expect(plan.candidates.map(item => item.path)).toContain(literal);
    expect(plan.candidates.map(item => item.path)).toContain(homeStore);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect(storage.sameStore(sourceBefore, await storage.inspectStoreAsync(homeStore), true)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("test-only-not-a-secret");
  });

  it("requires the old cwd or a chosen source for an omitted legacy default", async () => {
    await configure(undefined);
    const oldDefault = path.join(runtimeCwd, "~", ".blackdogbot", "knowledge", "lancedb");
    await makeStore(oldDefault);
    await expect(planDatabasePathMigrationAsync(dataDir)).rejects.toThrow("--runtime-cwd");
    expect((await planDatabasePathMigrationAsync(dataDir, { runtimeCwd })).sourcePath).toBe(oldDefault);
    await expect(assertDatabasePathMigrationReadyAsync(dataDir)).rejects.toThrow("stored knowledge path");
  });

  it("resolves ordinary relative paths from the old running release instead of the candidate cwd", async () => {
    await configure("relative/database");
    const source = path.join(runtimeCwd, "relative", "database");
    await makeStore(source);
    const plan = await planDatabasePathMigrationAsync(dataDir, { runtimeCwd });
    expect(plan.sourcePath).toBe(source);
  });

  it("refuses differing populated candidates until a source is chosen explicitly", async () => {
    await configure("~/.betterclaw/knowledge/lancedb");
    const literal = path.join(runtimeCwd, "~", ".betterclaw", "knowledge", "lancedb");
    const homeStore = path.join(fakeHome, ".betterclaw", "knowledge", "lancedb");
    await makeStore(literal, "literal");
    await makeStore(homeStore, "home");
    await expect(planDatabasePathMigrationAsync(dataDir, { runtimeCwd })).rejects.toThrow("Multiple populated");
    const plan = await planDatabasePathMigrationAsync(dataDir, { runtimeCwd, sourcePath: homeStore });
    expect(plan.sourcePath).toBe(homeStore);
    expect(plan.candidates.filter(item => item.populated)).toHaveLength(2);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });

  it("does not replace a different populated canonical database", async () => {
    const source = path.join(root, "external");
    await configure(source);
    await makeStore(source, "legacy");
    await makeStore(target, "new");
    await expect(applyDatabasePathMigrationAsync(dataDir, { sourcePath: source })).rejects.toThrow("destination database");
    expect(await rows(source)).toBe(1);
    expect(await rows(target)).toBe(1);
    await expect(fs.stat(path.join(dataDir, DATABASE_PATH_TRANSACTIONS))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an already covered custom absolute path unchanged", async () => {
    const custom = path.join(dataDir, "custom-knowledge");
    const before = await configure(custom);
    expect(await applyDatabasePathMigrationAsync(dataDir)).toMatchObject({ status: "unchanged", transactionId: null });
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    await assertDatabasePathMigrationReadyAsync(dataDir);
  });

  it("does not migrate an inactive knowledge provider", async () => {
    await configure(undefined, false);
    expect((await planDatabasePathMigrationAsync(dataDir)).needsMigration).toBe(false);
    await assertDatabasePathMigrationReadyAsync(dataDir);
  });

  it("refuses symlinked sources before writing migration metadata", async () => {
    const source = path.join(root, "real");
    await makeStore(source);
    const symlink = path.join(root, "linked");
    await fs.symlink(source, symlink);
    await configure(symlink);
    await expect(planDatabasePathMigrationAsync(dataDir)).rejects.toThrow("symlinks");
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });
});

describe("offline database path transactions", () => {
  it("copies a real Lance store, preserves source/config bytes, and rolls back repeatably", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const before = await configure(source);
    await fs.mkdir(target, { recursive: true, mode: 0o750 });
    const emptyIdentity = storage.identity(await fs.stat(target));
    const originalSource = await storage.inspectStoreAsync(source);
    const receipt = await applyDatabasePathMigrationAsync(dataDir);
    expect(receipt.status).toBe("applied");
    const id = receipt.transactionId!;
    expect(await rows(target)).toBe(1);
    expect(storage.sameStore(originalSource, await storage.inspectStoreAsync(source), true)).toBe(true);
    expect(await fs.readFile(transaction(id, "config.before"))).toEqual(before);
    expect((await fs.stat(transaction(id, "config.before"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(transaction(id, "journal.json")))).mode & 0o777).toBe(0o700);
    const after = await fs.readFile(path.join(dataDir, "config.yaml"), "utf8");
    expect(after).toBe(before.toString().replace(source, JSON.stringify(target)));
    expect(parse(after).knowledge.lancedbPath).toBe(target);
    expect(await applyDatabasePathMigrationAsync(dataDir)).toMatchObject({ status: "unchanged", transactionId: null });
    await assertDatabasePathMigrationReadyAsync(dataDir);
    expect(await rollbackDatabasePathMigrationAsync(dataDir, id)).toMatchObject({ status: "rolled_back", transactionId: id });
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect(storage.identity(await fs.stat(target))).toBe(emptyIdentity);
    expect(await fs.readdir(target)).toEqual([]);
    expect(await rows(transaction(id, "retained-data"))).toBe(1);
    expect((await rollbackDatabasePathMigrationAsync(dataDir, id)).status).toBe("rolled_back");
    expect((await recoverDatabasePathMigrationAsync(dataDir)).status).toBe("unchanged");
    expect((await applyDatabasePathMigrationAsync(dataDir)).status).toBe("applied");
  });

  it("can make an explicit configuration-only repair without changing the existing database", async () => {
    await makeStore(target);
    const before = await configure("relative/missing");
    const original = await storage.inspectStoreAsync(target);
    const applied = await applyDatabasePathMigrationAsync(dataDir, { runtimeCwd });
    expect(applied.sourcePath).toBe(target);
    await expect(fs.stat(transaction(applied.transactionId!, "validation"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(storage.sameStore(original, await storage.inspectStoreAsync(target), true)).toBe(true);
    await rollbackDatabasePathMigrationAsync(dataDir, applied.transactionId!);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect(storage.sameStore(original, await storage.inspectStoreAsync(target), true)).toBe(true);
  });

  it("does not roll back over new database records", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    await configure(source);
    const applied = await applyDatabasePathMigrationAsync(dataDir);
    await addRow(target);
    await expect(rollbackDatabasePathMigrationAsync(dataDir, applied.transactionId!)).rejects.toThrow("newer data");
    expect(await rows(target)).toBe(2);
    expect(await rows(source)).toBe(1);
    expect(parse(await fs.readFile(path.join(dataDir, "config.yaml"), "utf8")).knowledge.lancedbPath).toBe(target);
  });

  it("accepts a repeated explicit source after the destination has newer writes without recopying it", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    await configure(source);
    const applied = await applyDatabasePathMigrationAsync(dataDir, { sourcePath: source });
    await addRow(target);
    expect((await planDatabasePathMigrationAsync(dataDir, { sourcePath: source })).needsMigration).toBe(false);
    expect(await applyDatabasePathMigrationAsync(dataDir, { sourcePath: source })).toMatchObject({ status: "unchanged", transactionId: null });
    expect(await rows(target)).toBe(2);
    await expect(rollbackDatabasePathMigrationAsync(dataDir, applied.transactionId!)).rejects.toThrow("newer data");
  });

  it("does not roll back over newer configuration edits", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    await configure(source);
    const applied = await applyDatabasePathMigrationAsync(dataDir);
    await fs.appendFile(path.join(dataDir, "config.yaml"), "# newer edit\n");
    await expect(rollbackDatabasePathMigrationAsync(dataDir, applied.transactionId!)).rejects.toThrow("newer settings");
    expect(await rows(target)).toBe(1);
  });

  it("keeps a corrupt store unpublished and can recover the incomplete transaction", async () => {
    const source = path.join(root, "legacy");
    await fs.mkdir(path.join(source, "broken.lance"), { recursive: true });
    await fs.writeFile(path.join(source, "broken.lance", "invalid"), "not a lance database");
    const before = await configure(source);
    const id = await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    await expect(assertDatabasePathMigrationReadyAsync(dataDir)).rejects.toThrow("incomplete");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await recoverDatabasePathMigrationAsync(dataDir)).transactionId).toBe(id);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect(await fs.readFile(path.join(source, "broken.lance", "invalid"), "utf8")).toBe("not a lance database");
  });

  it("detects a corrupt data fragment even when the Lance manifest still counts its rows", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const inventory = await storage.inspectStoreAsync(source);
    const fragment = inventory.entries.find(entry => entry.type === "file" && entry.path.includes("/data/") && entry.path.endsWith(".lance"));
    expect(fragment).toBeDefined();
    await fs.writeFile(path.join(source, fragment!.path), "truncated data fragment");
    expect(await rows(source)).toBe(1);
    const before = await configure(source);
    const id = await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await recoverDatabasePathMigrationAsync(dataDir)).transactionId).toBe(id);
  });

  it("refuses a corrupt original-config backup", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    await configure(source);
    const applied = await applyDatabasePathMigrationAsync(dataDir);
    await fs.appendFile(transaction(applied.transactionId!, "config.before"), "corruption");
    await expect(rollbackDatabasePathMigrationAsync(dataDir, applied.transactionId!)).rejects.toThrow("checksum");
    expect(await rows(target)).toBe(1);
  });

  it("recovers a crash immediately after database publication", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const before = await configure(source);
    const publish = storage.atomicPublishAsync;
    const spy = vi.spyOn(storage, "atomicPublishAsync").mockImplementation(async (from, to) => {
      await publish(from, to);
      if (to === target) throw new Error("simulated process loss after publication");
    });
    const id = await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    spy.mockRestore();
    expect(await rows(target)).toBe(1);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect((await recoverDatabasePathMigrationAsync(dataDir)).transactionId).toBe(id);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await rows(transaction(id, "retained-data"))).toBe(1);
  });

  it("recovers a crash after config publication and before the applied receipt", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const before = await configure(source);
    const replace = storage.replaceFileAsync;
    const spy = vi.spyOn(storage, "replaceFileAsync").mockImplementation(async (file, content, mode) => {
      await replace(file, content, mode);
      if (file === path.join(dataDir, "config.yaml")) throw new Error("simulated config publication loss");
    });
    const id = await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    spy.mockRestore();
    expect(parse(await fs.readFile(path.join(dataDir, "config.yaml"), "utf8")).knowledge.lancedbPath).toBe(target);
    expect((await recoverDatabasePathMigrationAsync(dataDir)).transactionId).toBe(id);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
  });

  it("recovers an interrupted rollback after retaining copied data and restores the original empty inode", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const before = await configure(source);
    await fs.mkdir(target, { recursive: true });
    const originalIdentity = storage.identity(await fs.stat(target));
    const applied = await applyDatabasePathMigrationAsync(dataDir);
    const publish = storage.atomicPublishAsync;
    const spy = vi.spyOn(storage, "atomicPublishAsync").mockImplementation(async (from, to) => {
      await publish(from, to);
      if (to?.endsWith("/retained-data")) throw new Error("simulated rollback loss");
    });
    await expect(rollbackDatabasePathMigrationAsync(dataDir, applied.transactionId!)).rejects.toThrow("simulated");
    spy.mockRestore();
    expect((await recoverDatabasePathMigrationAsync(dataDir)).transactionId).toBe(applied.transactionId);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect(storage.identity(await fs.stat(target))).toBe(originalIdentity);
    expect(await rows(transaction(applied.transactionId!, "retained-data"))).toBe(1);
  });

  it("recovers a repeated rollback that first stopped before publication", async () => {
    const source = path.join(root, "legacy");
    await fs.mkdir(path.join(source, "broken.lance"), { recursive: true });
    await fs.writeFile(path.join(source, "broken.lance", "bad"), "bad");
    const before = await configure(source);
    const id = await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    const replace = storage.replaceFileAsync;
    const spy = vi.spyOn(storage, "replaceFileAsync").mockImplementation(async (file, content, mode) => {
      await replace(file, content, mode);
      if (file.endsWith("/journal.json") && JSON.parse(content.toString()).status === "rolling_back") throw new Error("rollback stopped");
    });
    await expect(recoverDatabasePathMigrationAsync(dataDir)).rejects.toThrow("rollback stopped");
    spy.mockRestore();
    expect((await recoverDatabasePathMigrationAsync(dataDir)).transactionId).toBe(id);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
  });


  it("refuses to undo a source write that occurred while copying", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const before = await configure(source);
    const copy = storage.copyStoreAsync;
    const spy = vi.spyOn(storage, "copyStoreAsync").mockImplementation(async (from, expected, destination) => {
      await copy(from, expected, destination);
      await addRow(source);
    });
    const id = await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    spy.mockRestore();
    expect(await rows(source)).toBe(2);
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(rollbackDatabasePathMigrationAsync(dataDir, id)).rejects.toThrow("newer data");
    expect(await rows(source)).toBe(2);
  });

  it("blocks startup and recovery when a published journal is corrupt", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    await configure(source);
    const applied = await applyDatabasePathMigrationAsync(dataDir);
    await fs.writeFile(transaction(applied.transactionId!, "journal.json"), "{incomplete");
    await expect(assertDatabasePathMigrationReadyAsync(dataDir)).rejects.toThrow("not valid JSON");
    await expect(recoverDatabasePathMigrationAsync(dataDir)).rejects.toThrow("not valid JSON");
    expect(await rows(target)).toBe(1);
  });

  it("refuses a destination created between verification and publication", async () => {
    const source = path.join(root, "legacy");
    await makeStore(source);
    const before = await configure(source);
    const publish = storage.atomicPublishAsync;
    const spy = vi.spyOn(storage, "atomicPublishAsync").mockImplementation(async (from, to) => {
      if (to === target) {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "new-writer"), "preserve");
      }
      await publish(from, to);
    });
    await transactionFailure(() => applyDatabasePathMigrationAsync(dataDir));
    spy.mockRestore();
    expect(await fs.readFile(path.join(target, "new-writer"), "utf8")).toBe("preserve");
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    await expect(recoverDatabasePathMigrationAsync(dataDir)).rejects.toThrow("ownership changed");
    expect(await rows(source)).toBe(1);
  });
});
