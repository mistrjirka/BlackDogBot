import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";
import {
  applyDataMigrationAsync,
  DATA_SCHEMA_FILE,
  LEGACY_IMPORTS_FILE,
  RETIRED_TRANSACTIONS_DIR,
  DataMigrationError,
  planDataMigrationAsync,
  prepareRuntimeDataAsync,
  recoverDataMigrationAsync,
  rollbackDataMigrationAsync,
} from "../../../src/migrations/data-migrations.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../src/migrations/cli.ts", import.meta.url));
let temporaryRoot: string;
let dataDir: string;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-migration-test-"));
  dataDir = path.join(temporaryRoot, "data");
  await writeTestConfigAsync(path.join(dataDir, "config.yaml"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

async function exists(relative: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dataDir, relative));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(name = "legacy-interval"): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(new URL("../../fixtures/migrations/timed/" + name + ".json", import.meta.url), "utf8"));
}

async function writeTask(id = "first", name = "legacy-interval", mode = 0o640): Promise<Buffer> {
  const value = { ...await fixture(name), taskId: id };
  const content = Buffer.from(JSON.stringify(value, null, 4) + "\n\n");
  await fs.mkdir(path.join(dataDir, "timed"), { recursive: true });
  const file = path.join(dataDir, "timed", id + ".json");
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
  return content;
}

async function read(relative: string): Promise<Buffer> {
  return fs.readFile(path.join(dataDir, relative));
}

async function readJson(relative: string): Promise<any> {
  return JSON.parse((await read(relative)).toString("utf8"));
}

function transactionPath(id: string, child: string): string {
  return ".migrations/transactions/" + id + "/" + child;
}

async function journal(id: string): Promise<any> {
  try { return await readJson(transactionPath(id, "journal.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readJson(RETIRED_TRANSACTIONS_DIR + "/" + id + "/journal.json");
  }
}

async function requireApplied(): Promise<string> {
  const receipt = await applyDataMigrationAsync(dataDir);
  expect(receipt.status).toBe("applied");
  expect(receipt.transactionId).toMatch(/^t-/);
  return receipt.transactionId!;
}

async function snapshotTree(directory: string): Promise<unknown> {
  const entries: Record<string, unknown> = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    entries[name] = stat.isSymbolicLink()
      ? { link: await fs.readlink(file) }
      : stat.isDirectory()
        ? { mode: stat.mode & 0o777, entries: await snapshotTree(file) }
        : { mode: stat.mode & 0o777, content: (await fs.readFile(file)).toString("base64") };
  }
  return entries;
}

async function snapshotManaged(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of [DATA_SCHEMA_FILE, LEGACY_IMPORTS_FILE, "timed"]) {
    if (!await exists(name)) continue;
    const full = path.join(dataDir, name);
    const stat = await fs.stat(full);
    result[name] = stat.isDirectory() ? await snapshotTree(full)
      : { mode: stat.mode & 0o777, content: (await fs.readFile(full)).toString("base64") };
  }
  return result;
}

async function runCli(command: string, extra: string[] = []): Promise<{ code: number; output: Record<string, any>; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, command, "--data-dir", dataDir, ...extra], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      timeout: 15_000,
      env: { ...process.env, BLACKDOGBOT_DATA_DIR: dataDir },
    });
    return { code: 0, output: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: JSON.parse(result.stdout), stderr: result.stderr };
  }
}

describe("read-only migration planning", () => {
  it("detects an unversioned fresh config without creating metadata", async () => {
    const before = await snapshotTree(dataDir);
    const plan = await planDataMigrationAsync(dataDir);
    expect(plan).toMatchObject({
      protocolVersion: 1,
      fromVersion: 0,
      toVersion: 2,
      needsMigration: true,
      scope: "timed-tasks",
      config: { telegramEnabled: false, discordEnabled: false },
      timezone: "UTC",
    });
    expect(plan.changes.map(item => item.path)).toEqual([LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(await exists(".migrations")).toBe(false);
  });

  it("reports file names and reasons without returning task data or credentials", async () => {
    await writeTask();
    const before = await snapshotTree(dataDir);
    const plan = await planDataMigrationAsync(dataDir);
    const output = JSON.stringify(plan);
    expect(plan.changes.map(item => item.path)).toEqual(["timed/first.json", LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);
    expect(output).not.toContain("test-only-not-a-secret");
    expect(output).not.toContain("Prior summary");
    expect(output).not.toContain("Use the configured tools");
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("validates all tasks before allowing any change", async () => {
    const original = await writeTask("first");
    await fs.writeFile(path.join(dataDir, "timed", "second.json"), "{invalid");
    const before = await snapshotManaged();

    await expect(applyDataMigrationAsync(dataDir)).rejects.toThrow("Invalid JSON");
    expect(await snapshotManaged()).toEqual(before);
    expect(await read("timed/first.json")).toEqual(original);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    expect(await exists(".migrations/transactions")).toBe(false);
  });

  it("rejects legacy cron files instead of assuming there are no saved jobs", async () => {
    await fs.mkdir(path.join(dataDir, "cron"));
    await fs.writeFile(path.join(dataDir, "cron", "legacy.json"), "{}");
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("Legacy cron/*.json");
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("retains a completed legacy cron record through plan, apply, and rollback without importing it", async () => {
    const content = await fs.readFile(new URL("../../fixtures/migrations/cron/completed-once.json", import.meta.url));
    const raw = JSON.parse(content.toString("utf8"));
    const relative = "cron/" + raw.taskId + ".json";
    const filename = path.join(dataDir, relative);
    await fs.mkdir(path.join(dataDir, "cron"));
    await fs.writeFile(filename, content, { mode: 0o640 });
    await fs.chmod(filename, 0o640);
    const before = await snapshotTree(dataDir);

    const plan = await planDataMigrationAsync(dataDir);
    expect(plan.preservedLegacyRecords).toBe(1);
    expect(plan.changes.map(change => change.path)).toEqual([LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(await exists("timed")).toBe(false);

    const id = await requireApplied();
    expect(await read(relative)).toEqual(content);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o640);
    expect(await exists("timed")).toBe(false);
    expect((await planDataMigrationAsync(dataDir)).preservedLegacyRecords).toBe(1);
    expect((await journal(id)).files.map((file: any) => file.path)).toEqual([LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);

    await rollbackDataMigrationAsync(dataDir, id);
    expect(await read(relative)).toEqual(content);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o640);
    expect(await exists("timed")).toBe(false);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    expect((await planDataMigrationAsync(dataDir)).preservedLegacyRecords).toBe(1);
  });

  it("blocks a mixture of completed and pending legacy cron records without changing any file", async () => {
    const content = await fs.readFile(new URL("../../fixtures/migrations/cron/completed-once.json", import.meta.url));
    const completed = JSON.parse(content.toString("utf8"));
    await fs.mkdir(path.join(dataDir, "cron"));
    await fs.writeFile(path.join(dataDir, "cron", completed.taskId + ".json"), content);
    const pending = { ...completed, taskId: "pending-once", lastRunAt: null, lastRunStatus: null };
    await fs.writeFile(path.join(dataDir, "cron", "pending-once.json"), JSON.stringify(pending));
    const before = await snapshotTree(dataDir);

    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow(/Legacy cron/);
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(await exists(".migrations")).toBe(false);
    expect(await exists("timed")).toBe(false);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
  });

  it.each([
    { formatVersion: 1, schemaVersion: 3, components: { timedTasks: 1, legacyCronImports: 1 } },
    { formatVersion: 1, schemaVersion: 2, components: { timedTasks: 2 } },
    { formatVersion: 2, schemaVersion: 1, components: { timedTasks: 1 } },
    { formatVersion: 1, schemaVersion: 0, components: { timedTasks: 1 } },
    { formatVersion: 1, schemaVersion: 1, components: { timedTasks: 2 } },
    { formatVersion: 1, schemaVersion: 1, components: { timedTasks: 1, futureData: 1 } },
    { formatVersion: 1, schemaVersion: "1", components: { timedTasks: 1 } },
  ])("refuses an unknown or newer schema marker", async marker => {
    await fs.writeFile(path.join(dataDir, DATA_SCHEMA_FILE), JSON.stringify(marker));
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow(/schema|newer release/);
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it.each(["different", "../outside", "..", ".", "nested/task", "nested\\task"])(
    "rejects stored taskId %s when it cannot safely match the filename",
    async taskId => {
      await writeTask();
      const file = path.join(dataDir, "timed", "first.json");
      await fs.writeFile(file, JSON.stringify({ ...await fixture(), taskId }));
      await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("must match its stored taskId");
      expect(await exists(".migrations")).toBe(false);
    },
  );

  it("does not include invalid configuration values in errors", async () => {
    const secret = "do-not-return-this-api-token";
    await fs.writeFile(path.join(dataDir, "config.yaml"), "ai:\n  provider: " + secret + "\n");
    try {
      await planDataMigrationAsync(dataDir);
      throw new Error("Expected validation failure");
    } catch (error) {
      expect((error as Error).message).toContain("config.yaml is incompatible");
      expect((error as Error).message).not.toContain(secret);
    }
    expect(await exists(".migrations")).toBe(false);
  });

  it("does not include invalid task enum values in errors", async () => {
    const secret = "do-not-return-this-task-value";
    await writeTask();
    await fs.writeFile(path.join(dataDir, "timed", "first.json"),
      JSON.stringify({ ...await fixture(), taskId: "first", lastRunStatus: secret }));
    try {
      await planDataMigrationAsync(dataDir);
      throw new Error("Expected validation failure");
    } catch (error) {
      expect((error as Error).message).toContain("lastRunStatus");
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("apply, verify, and restore", () => {
  it("records an already compatible baseline and does not rewrite config", async () => {
    const configBefore = await read("config.yaml");
    const id = await requireApplied();
    expect(await readJson(DATA_SCHEMA_FILE)).toEqual({
      formatVersion: 1, schemaVersion: 2, components: { timedTasks: 1, legacyCronImports: 1 },
    });
    expect(await journal(id)).toMatchObject({
      status: "applied", fromVersion: 0, toVersion: 2,
    });
    expect(await read("config.yaml")).toEqual(configBefore);
    expect((await planDataMigrationAsync(dataDir)).needsMigration).toBe(false);
  });

  it("preserves exact original bytes and permissions through rollback", async () => {
    const original = await writeTask("first", "legacy-interval", 0o640);
    const configBefore = await read("config.yaml");
    const id = await requireApplied();
    const transaction = await journal(id);
    expect(transaction.files.map((item: any) => item.path)).toEqual(["timed/first.json", LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);
    expect(await read(transactionPath(id, "0000.before"))).toEqual(original);
    expect(transaction.files[0].beforeMode).toBe(0o640);
    expect((await fs.stat(path.join(dataDir, "timed", "first.json"))).mode & 0o777).toBe(0o640);
    expect((await fs.stat(path.join(dataDir, transactionPath(id, "0000.before")))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dataDir, ".migrations", "transactions", id))).mode & 0o777).toBe(0o700);
    const migrated = await readJson("timed/first.json");
    const old = JSON.parse(original.toString());
    expect(migrated).toMatchObject({
      taskId: old.taskId, updatedAt: old.updatedAt, createdAt: old.createdAt,
      messageHistory: old.messageHistory, extension: old.extension, messageDedupEnabled: true,
    });
    expect(migrated.schedule.extension).toEqual(old.schedule.extension);
    expect(migrated.schedule.every).toEqual({ hours: 24, minutes: 0 });

    await expect(rollbackDataMigrationAsync(dataDir, id)).resolves.toMatchObject({ status: "rolled_back", transactionId: id });
    expect(await read("timed/first.json")).toEqual(original);
    expect((await fs.stat(path.join(dataDir, "timed", "first.json"))).mode & 0o777).toBe(0o640);
    expect(await read("config.yaml")).toEqual(configBefore);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    expect((await journal(id)).status).toBe("rolled_back");
    await expect(rollbackDataMigrationAsync(dataDir, id)).resolves.toMatchObject({ status: "rolled_back" });
  });

  it.each(["legacy-once", "legacy-interval", "modern-before-dedup"])("upgrades the %s fixture exactly once", async fixtureName => {
    const original = await writeTask("fixture", fixtureName);
    const id = await requireApplied();
    const after = await snapshotManaged();
    expect(await applyDataMigrationAsync(dataDir)).toEqual({
      protocolVersion: 1, status: "unchanged", transactionId: null,
    });
    expect(await snapshotManaged()).toEqual(after);
    expect((await planDataMigrationAsync(dataDir)).changes).toEqual([]);
    expect(await fs.readdir(path.join(dataDir, ".migrations", "transactions"))).toEqual([id]);
    if (fixtureName === "legacy-once") {
      expect((await readJson("timed/fixture.json")).schedule.runAt).toBe(JSON.parse(original.toString()).schedule.runAt);
    }
  });

  it("does not touch unmanaged sessions, databases, prompts, or config during apply and restore", async () => {
    await writeTask();
    const unmanaged = ["sessions/saved.json", "databases/saved.db", "prompts/custom.md", "skills/custom/code.js"];
    for (const relative of unmanaged) {
      await fs.mkdir(path.dirname(path.join(dataDir, relative)), { recursive: true });
      await fs.writeFile(path.join(dataDir, relative), "unchanged fixture " + relative);
    }
    const before = await Promise.all(unmanaged.map(read));
    const id = await requireApplied();
    await rollbackDataMigrationAsync(dataDir, id);
    expect(await Promise.all(unmanaged.map(read))).toEqual(before);
  });

  it("requires reverse transaction order, including when the clock moves backwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
    const firstOriginal = await writeTask("first");
    const firstId = await requireApplied();

    vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
    const secondOriginal = await writeTask("second", "legacy-once");
    const secondId = await requireApplied();
    await expect(rollbackDataMigrationAsync(dataDir, firstId)).rejects.toThrow("newest");
    await rollbackDataMigrationAsync(dataDir, secondId);
    expect(await read("timed/second.json")).toEqual(secondOriginal);
    await rollbackDataMigrationAsync(dataDir, firstId);
    expect(await read("timed/first.json")).toEqual(firstOriginal);
    expect(await read("timed/second.json")).toEqual(secondOriginal);
  });
});

describe("interruption and conflict recovery", () => {
  it("blocks startup after partial application and restores all original files", async () => {
    const first = await writeTask("first", "legacy-interval", 0o640);
    const second = await writeTask("second", "legacy-once", 0o600);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === path.join(dataDir, "timed", "second.json")) {
        throw Object.assign(new Error("Injected disk full"), { code: "ENOSPC" });
      }
      return rename(source, destination);
    });

    let transactionId: string | undefined;
    try {
      await applyDataMigrationAsync(dataDir);
      throw new Error("Expected application failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DataMigrationError);
      transactionId = (error as DataMigrationError).transactionId;
      expect(transactionId).toMatch(/^t-/);
    }
    failure.mockRestore();
    expect(await read("timed/first.json")).not.toEqual(first);
    expect(await read("timed/second.json")).toEqual(second);
    expect((await journal(transactionId!)).status).toBe("applying");
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("incomplete");
    await expect(prepareRuntimeDataAsync(dataDir)).rejects.toThrow("incomplete");

    await expect(recoverDataMigrationAsync(dataDir)).resolves.toMatchObject({
      status: "rolled_back", transactionId,
    });
    expect(await read("timed/first.json")).toEqual(first);
    expect(await read("timed/second.json")).toEqual(second);
    expect((await fs.stat(path.join(dataDir, "timed", "first.json"))).mode & 0o777).toBe(0o640);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    await expect(recoverDataMigrationAsync(dataDir)).resolves.toMatchObject({ status: "unchanged" });
    expect((await planDataMigrationAsync(dataDir)).needsMigration).toBe(true);
  });

  it("resumes an interrupted rollback without restoring newer user edits", async () => {
    const first = await writeTask("first");
    const second = await writeTask("second", "legacy-once");
    const id = await requireApplied();
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === path.join(dataDir, "timed", "first.json")) {
        throw Object.assign(new Error("Injected I/O failure"), { code: "EIO" });
      }
      return rename(source, destination);
    });
    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow();
    failure.mockRestore();
    expect((await journal(id)).status).toBe("rolling_back");
    expect(await read("timed/second.json")).toEqual(second);
    expect(await read("timed/first.json")).not.toEqual(first);
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("incomplete");

    await recoverDataMigrationAsync(dataDir);
    expect(await read("timed/first.json")).toEqual(first);
    expect(await read("timed/second.json")).toEqual(second);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
  });

  it.each(["before", "after"])("checks every %s backup before restoring any file", async kind => {
    await writeTask("first");
    await writeTask("second", "legacy-once");
    const id = await requireApplied();
    const before = await snapshotManaged();
    await fs.writeFile(path.join(dataDir, transactionPath(id, "0001." + kind)), "corrupted");

    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("checksum");
    expect(await snapshotManaged()).toEqual(before);
    expect((await journal(id)).status).toBe("applied");
  });

  it("refuses missing backup files before restoring anything", async () => {
    await writeTask("first");
    await writeTask("second");
    const id = await requireApplied();
    const before = await snapshotManaged();
    await fs.rm(path.join(dataDir, transactionPath(id, "0001.before")));
    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("checksum");
    expect(await snapshotManaged()).toEqual(before);
  });

  it("preserves every file when a user edits any migrated file", async () => {
    await writeTask("first");
    await writeTask("second");
    const id = await requireApplied();
    await fs.appendFile(path.join(dataDir, "timed", "second.json"), " \n");
    const before = await snapshotManaged();

    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("discard newer data");
    expect(await snapshotManaged()).toEqual(before);
    expect((await journal(id)).status).toBe("applied");
  });

  it("treats a newer file permission change as a rollback conflict", async () => {
    await writeTask("first", "legacy-interval", 0o640);
    const id = await requireApplied();
    await fs.chmod(path.join(dataDir, "timed", "first.json"), 0o600);
    const before = await snapshotManaged();

    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("discard newer data");
    expect(await snapshotManaged()).toEqual(before);
  });
});

describe("symlink boundaries", () => {
  it.each(["config", "timed", "task", "metadata", "transactions"])("rejects a symlink %s without changing its target", async location => {
    await writeTask("first");
    const outside = path.join(temporaryRoot, "outside");
    await fs.mkdir(outside);
    let target: string;
    let source: string;
    if (location === "config") {
      target = path.join(outside, "config.yaml");
      source = path.join(dataDir, "config.yaml");
      await fs.rename(source, target);
    } else if (location === "task") {
      target = path.join(outside, "first.json");
      source = path.join(dataDir, "timed", "first.json");
      await fs.rename(source, target);
    } else if (location === "timed") {
      target = path.join(outside, "timed");
      source = path.join(dataDir, "timed");
      await fs.rename(source, target);
    } else {
      target = path.join(outside, "metadata");
      await fs.mkdir(target);
      source = path.join(dataDir, ".migrations");
      if (location === "transactions") {
        await fs.mkdir(source);
        source = path.join(source, "transactions");
      }
    }
    await fs.symlink(target, source);
    const before = await snapshotTree(outside);
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow(/symlink/);
    expect(await snapshotTree(outside)).toEqual(before);
  });

  it("rejects a symlink data root", async () => {
    const linked = path.join(temporaryRoot, "linked");
    await fs.symlink(dataDir, linked);
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(linked)).rejects.toThrow(/symlink/);
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("refuses a replaced backup symlink before any restore", async () => {
    await writeTask("first");
    await writeTask("second");
    const id = await requireApplied();
    const original = path.join(dataDir, transactionPath(id, "0001.before"));
    const outside = path.join(temporaryRoot, "outside-backup");
    await fs.rename(original, outside);
    await fs.symlink(outside, original);
    const before = await snapshotManaged();
    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow(/symlink/);
    expect(await snapshotManaged()).toEqual(before);
  });
});

describe("runtime exclusion and command protocol", () => {
  it("records a compatible baseline and holds an exclusive runtime lock", async () => {
    const lock = await prepareRuntimeDataAsync(dataDir);
    try {
      expect(await exists(DATA_SCHEMA_FILE)).toBe(true);
      await expect(applyDataMigrationAsync(dataDir)).rejects.toThrow(/locked by runtime/);
      await expect(recoverDataMigrationAsync(dataDir)).rejects.toThrow(/still running/);
      expect((await planDataMigrationAsync(dataDir)).needsMigration).toBe(false);
    } finally {
      await lock.releaseAsync();
    }
    await expect(applyDataMigrationAsync(dataDir)).resolves.toMatchObject({ status: "unchanged" });
  });

  it("refuses runtime startup with pending task conversions and leaves their bytes unchanged", async () => {
    const original = await writeTask();
    await expect(prepareRuntimeDataAsync(dataDir)).rejects.toThrow("Stored tasks require migration");
    expect(await read("timed/first.json")).toEqual(original);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    expect(await exists(".migrations/lock.json")).toBe(false);
  });

  it("releases its owned runtime lock when startup is cancelled during planning", async () => {
    const engine = fileURLToPath(new URL("../../../src/migrations/data-migrations.ts", import.meta.url));
    const script = [
      'import fs from "node:fs/promises";',
      'import { pathToFileURL } from "node:url";',
      'const { prepareRuntimeDataAsync } = await import(pathToFileURL(' + JSON.stringify(engine) + '));',
      'process.once("SIGTERM", () => process.exit(143));',
      'setInterval(() => {}, 1_000);',
      'const originalReadFile = fs.readFile.bind(fs);',
      'fs.readFile = async (...args) => {',
      '  if (String(args[0]) === ' + JSON.stringify(path.join(dataDir, "config.yaml")) + ') {',
      '    process.stdout.write("planning\\n");',
      '    await new Promise(() => {});',
      '  }',
      '  return originalReadFile(...args);',
      '};',
      'await prepareRuntimeDataAsync(' + JSON.stringify(dataDir) + ');',
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env, BLACKDOGBOT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Child did not reach planning: " + stderr)), 5_000);
        child.stdout.on("data", () => {
          if (output.includes("planning")) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => {
          if (!output.includes("planning")) reject(new Error("Child exited before planning: " + stderr));
        });
      });
      expect(await exists(".migrations/lock.json")).toBe(true);
      expect(child.kill("SIGTERM")).toBe(true);
      expect(await exited).toBe(143);
      expect(await exists(".migrations/lock.json")).toBe(false);
      expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
      expect(await exists(".migrations/transactions")).toBe(false);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("exposes a read-only JSON plan through the CLI", async () => {
    await writeTask();
    const before = await snapshotTree(dataDir);
    const result = await runCli("plan");
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("test-only-not-a-secret");
    expect(result.output).toMatchObject({ protocolVersion: 1, needsMigration: true, scope: "timed-tasks" });
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(JSON.stringify(result.output)).not.toContain("test-only-not-a-secret");
  });

  it("requires offline confirmation before a CLI mutation", async () => {
    const before = await snapshotTree(dataDir);
    const result = await runCli("apply");
    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({ protocolVersion: 1, status: "failed" });
    expect(result.output.error).toContain("--offline");
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("returns usable receipts for CLI apply and rollback", async () => {
    const original = await writeTask();
    const applied = await runCli("apply", ["--offline"]);
    expect(applied.code).toBe(0);
    expect(applied.output).toMatchObject({ protocolVersion: 1, status: "applied" });
    expect(typeof applied.output.transactionId).toBe("string");
    const rolledBack = await runCli("rollback", ["--offline", "--transaction", applied.output.transactionId]);
    expect(rolledBack.code).toBe(0);
    expect(rolledBack.output.status).toBe("rolled_back");
    expect(await read("timed/first.json")).toEqual(original);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
  });

  it("reports the actual lock conflict through the CLI", async () => {
    const lock = await prepareRuntimeDataAsync(dataDir);
    try {
      const result = await runCli("apply", ["--offline"]);
      expect(result.code).toBe(1);
      expect(result.output.error).toContain("locked by runtime");
      expect(result.output.error).not.toContain("unexpected error");
    } finally {
      await lock.releaseAsync();
    }
  });

  it("rejects a transaction option for read-only planning", async () => {
    const result = await runCli("plan", ["--transaction", "invalid"]);
    expect(result.code).toBe(1);
    expect(result.output.error).toContain("only valid for rollback");
    expect(await exists(".migrations")).toBe(false);
  });
});

async function writeLegacyImportFixture(
  fixtureName: "pending-once" | "interval" = "pending-once",
  updates: Record<string, unknown> = {},
): Promise<{ relative: string; target: string; raw: Record<string, any>; content: Buffer }> {
  const raw = {
    ...JSON.parse(await fs.readFile(new URL("../../fixtures/migrations/legacy-imports/" + fixtureName + ".json", import.meta.url), "utf8")),
    ...updates,
  };
  const content = Buffer.from(JSON.stringify(raw, null, 4) + "\n\n");
  const relative = "cron/" + raw.taskId + ".json";
  const target = "timed/" + raw.taskId + ".json";
  await fs.mkdir(path.join(dataDir, "cron"), { recursive: true });
  await fs.writeFile(path.join(dataDir, relative), content, { mode: 0o640 });
  await fs.chmod(path.join(dataDir, relative), 0o640);
  return { relative, target, raw, content };
}

async function installSchemaOneFixture(): Promise<{ id: string; marker: Buffer; originalJournal: Buffer }> {
  const fixtureRoot = new URL("../../fixtures/migrations/schema1/", import.meta.url);
  const marker = await fs.readFile(new URL("marker.json", fixtureRoot));
  const originalJournal = await fs.readFile(new URL("journal.json", fixtureRoot));
  const id = JSON.parse(originalJournal.toString("utf8")).id;
  const transactionDir = path.join(dataDir, ".migrations", "transactions", id);
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDir, DATA_SCHEMA_FILE), marker, { mode: 0o600 });
  await fs.writeFile(path.join(transactionDir, "journal.json"), originalJournal, { mode: 0o600 });
  await fs.writeFile(path.join(transactionDir, "0000.after"), marker, { mode: 0o600 });
  return { id, marker, originalJournal };
}

describe("explicit legacy cron import", () => {
  const options = { importLegacyTasks: true };

  it("requires opt-in and leaves source data unchanged when it is absent", async () => {
    const source = await writeLegacyImportFixture();
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("--import-legacy-tasks");
    expect(await snapshotTree(dataDir)).toEqual(before);
    await expect(applyDataMigrationAsync(dataDir)).rejects.toThrow("--import-legacy-tasks");
    expect(await read(source.relative)).toEqual(source.content);
    expect(await exists("timed")).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
  });

  it("preserves once-task identity, runAt, enabled, history, extensions, and original bytes", async () => {
    const source = await writeLegacyImportFixture();
    const before = await snapshotTree(dataDir);
    const plan = await planDataMigrationAsync(dataDir, options);
    expect(plan).toMatchObject({ legacyTasksToImport: 1, recordedLegacyImports: 0, preservedLegacyRecords: 0 });
    expect(plan.changes.map(change => change.path)).toEqual([source.target, LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(JSON.stringify(plan)).not.toContain(source.raw.instructions);
    expect(JSON.stringify(plan)).not.toContain("Prior summary");

    const receipt = await applyDataMigrationAsync(dataDir, options);
    expect(receipt.status).toBe("applied");
    expect(await read(source.relative)).toEqual(source.content);
    expect((await fs.stat(path.join(dataDir, source.relative))).mode & 0o777).toBe(0o640);
    const task = await readJson(source.target);
    expect(task).toMatchObject({
      taskId: source.raw.taskId, enabled: source.raw.enabled,
      createdAt: source.raw.createdAt, updatedAt: source.raw.updatedAt,
      lastRunAt: source.raw.lastRunAt, lastRunStatus: source.raw.lastRunStatus,
      messageHistory: source.raw.messageHistory, extension: source.raw.extension,
      schedule: { runAt: source.raw.schedule.runAt },
    });
    expect((await fs.stat(path.join(dataDir, source.target))).mode & 0o777).toBe(0o640);
    expect((await fs.stat(path.join(dataDir, LEGACY_IMPORTS_FILE))).mode & 0o777).toBe(0o600);
    const ledger = await readJson(LEGACY_IMPORTS_FILE);
    expect(ledger).toMatchObject({
      formatVersion: 1,
      entries: [{ source: source.relative, taskId: source.raw.taskId, target: source.target }],
    });
    expect(ledger.entries[0].sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain("Prior summary");
    expect((await journal(receipt.transactionId!)).files.map((file: any) => file.path)).not.toContain(source.relative);
  });

  it("reports the interval timing conversion and keeps disabled tasks disabled", async () => {
    const source = await writeLegacyImportFixture("interval");
    const plan = await planDataMigrationAsync(dataDir, options);
    expect(plan.changes.find(change => change.path === source.target)!.reasons.join(" ")).toContain("day-start grid");
    await applyDataMigrationAsync(dataDir, options);
    const task = await readJson(source.target);
    expect(task.enabled).toBe(false);
    expect(task.schedule).toMatchObject({
      type: "interval",
      every: { hours: 24, minutes: 0 },
      offsetFromDayStart: { hours: 18, minutes: 0 },
      timezone: "UTC",
    });
    expect(await read(source.relative)).toEqual(source.content);
  });

  it("does not import known completed records when other legacy tasks are opted in", async () => {
    const source = await writeLegacyImportFixture();
    const completed = await fs.readFile(new URL("../../fixtures/migrations/cron/completed-once.json", import.meta.url));
    const completedId = JSON.parse(completed.toString("utf8")).taskId;
    const completedPath = "cron/" + completedId + ".json";
    await fs.writeFile(path.join(dataDir, completedPath), completed);
    const plan = await planDataMigrationAsync(dataDir, options);
    expect(plan).toMatchObject({ legacyTasksToImport: 1, preservedLegacyRecords: 1 });
    await applyDataMigrationAsync(dataDir, options);
    expect(await exists(source.target)).toBe(true);
    expect(await exists("timed/" + completedId + ".json")).toBe(false);
    expect(await read(completedPath)).toEqual(completed);
  });

  it("rejects an existing target even when its contents resemble the source", async () => {
    const source = await writeLegacyImportFixture();
    await fs.mkdir(path.join(dataDir, "timed"));
    await fs.writeFile(path.join(dataDir, source.target), source.content);
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow("target already exists");
    expect(await snapshotTree(dataDir)).toEqual(before);
    const managed = await snapshotManaged();
    await expect(applyDataMigrationAsync(dataDir, options)).rejects.toThrow("target already exists");
    expect(await snapshotManaged()).toEqual(managed);
    expect(await read(source.relative)).toEqual(source.content);
  });

  it.each([
    { type: "scheduled", intervalMinutes: 60, startHour: null, startMinute: null, runOnce: false },
    { type: "cron", expression: "0 * * * *" },
    { type: "interval", intervalMs: 60_000, every: { hours: 2, minutes: 0 } },
  ])("blocks mixed supported and unsupported sources before any writes", async schedule => {
    const supported = await writeLegacyImportFixture();
    const unsupported = await writeLegacyImportFixture("interval", { taskId: "unsupported", schedule });
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow("Cannot migrate timed task");
    expect(await snapshotTree(dataDir)).toEqual(before);
    await expect(applyDataMigrationAsync(dataDir, options)).rejects.toThrow("Cannot migrate timed task");
    expect(await read(supported.relative)).toEqual(supported.content);
    expect(await read(unsupported.relative)).toEqual(unsupported.content);
    expect(await exists("timed")).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
  });

  it("records an import once and does not recreate a task that the user later deletes", async () => {
    const source = await writeLegacyImportFixture();
    const receipt = await applyDataMigrationAsync(dataDir, options);
    const content = await read(source.target);
    expect(await applyDataMigrationAsync(dataDir, options)).toMatchObject({ status: "unchanged", transactionId: null });
    expect(await read(source.target)).toEqual(content);
    expect((await planDataMigrationAsync(dataDir)).recordedLegacyImports).toBe(1);
    await fs.unlink(path.join(dataDir, source.target));

    const plan = await planDataMigrationAsync(dataDir, options);
    expect(plan).toMatchObject({ needsMigration: false, legacyTasksToImport: 0, recordedLegacyImports: 1 });
    expect(await applyDataMigrationAsync(dataDir, options)).toMatchObject({ status: "unchanged" });
    const runtime = await prepareRuntimeDataAsync(dataDir);
    await runtime.releaseAsync();
    expect(await exists(source.target)).toBe(false);
    expect(await read(source.relative)).toEqual(source.content);
    expect(await fs.readdir(path.join(dataDir, ".migrations", "transactions"))).toEqual([receipt.transactionId]);
  });

  it.each(["changed", "missing"])("blocks a %s recorded source instead of accepting or re-importing it", async kind => {
    const source = await writeLegacyImportFixture();
    await applyDataMigrationAsync(dataDir, options);
    if (kind === "changed") await fs.appendFile(path.join(dataDir, source.relative), " ");
    else await fs.unlink(path.join(dataDir, source.relative));
    const before = await snapshotManaged();
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("source is missing or changed");
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow("source is missing or changed");
    await expect(prepareRuntimeDataAsync(dataDir)).rejects.toThrow("source is missing or changed");
    expect(await snapshotManaged()).toEqual(before);
  });

  it("does not reconstruct a missing ledger or resurrect a deleted target", async () => {
    const source = await writeLegacyImportFixture();
    await applyDataMigrationAsync(dataDir, options);
    await fs.unlink(path.join(dataDir, source.target));
    await fs.unlink(path.join(dataDir, LEGACY_IMPORTS_FILE));
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow("legacy import ledger is missing");
    await expect(applyDataMigrationAsync(dataDir, options)).rejects.toThrow("legacy import ledger is missing");
    expect(await exists(source.target)).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect(await read(source.relative)).toEqual(source.content);
  });

  it("rejects valid-JSON ledger truncation instead of resurrecting a deleted task", async () => {
    const source = await writeLegacyImportFixture();
    await applyDataMigrationAsync(dataDir, options);
    await fs.unlink(path.join(dataDir, source.target));
    await fs.writeFile(path.join(dataDir, LEGACY_IMPORTS_FILE), JSON.stringify({ formatVersion: 1, entries: [] }));
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow("committed migration history");
    await expect(applyDataMigrationAsync(dataDir, options)).rejects.toThrow("committed migration history");
    expect(await exists(source.target)).toBe(false);
    expect(await read(source.relative)).toEqual(source.content);
  });

  it("requires committed ledger history for schema 2 metadata", async () => {
    await fs.mkdir(path.join(dataDir, ".migrations"));
    await fs.writeFile(path.join(dataDir, LEGACY_IMPORTS_FILE),
      JSON.stringify({ formatVersion: 1, entries: [] }), { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, DATA_SCHEMA_FILE),
      JSON.stringify({ formatVersion: 1, schemaVersion: 2, components: { timedTasks: 1, legacyCronImports: 1 } }), { mode: 0o600 });
    const before = await snapshotTree(dataDir);
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("committed migration history");
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("checks prior applied ledger history after a later import is rolled back", async () => {
    await requireApplied();
    await writeLegacyImportFixture();
    const receipt = await applyDataMigrationAsync(dataDir, options);
    await rollbackDataMigrationAsync(dataDir, receipt.transactionId!);
    await expect(planDataMigrationAsync(dataDir, options)).resolves.toMatchObject({
      fromVersion: 2, toVersion: 2, recordedLegacyImports: 0, legacyTasksToImport: 1,
    });
    expect(await readJson(LEGACY_IMPORTS_FILE)).toEqual({ formatVersion: 1, entries: [] });
  });

  it.each(["duplicate", "wrong-target", "wrong-hash", "unknown-format"])("rejects %s ledger metadata without changing task data", async kind => {
    const source = await writeLegacyImportFixture();
    await applyDataMigrationAsync(dataDir, options);
    const ledger = await readJson(LEGACY_IMPORTS_FILE);
    if (kind === "duplicate") ledger.entries.push({ ...ledger.entries[0] });
    if (kind === "wrong-target") ledger.entries[0].target = "timed/other.json";
    if (kind === "wrong-hash") ledger.entries[0].sourceSha256 = "not-a-sha256";
    if (kind === "unknown-format") ledger.formatVersion = 2;
    await fs.writeFile(path.join(dataDir, LEGACY_IMPORTS_FILE), JSON.stringify(ledger));
    const before = await snapshotManaged();
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow(/ledger/);
    expect(await snapshotManaged()).toEqual(before);
    expect(await read(source.relative)).toEqual(source.content);
  });

  it("rechecks source content after publishing backups and before creating any imported task", async () => {
    const source = await writeLegacyImportFixture();
    const rename = fs.rename.bind(fs);
    let changed = false;
    const injection = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!changed && String(from).includes("/.staging-t-") && path.basename(String(to)).startsWith("t-")) {
        changed = true;
        await fs.appendFile(path.join(dataDir, source.relative), " ");
      }
    });
    await expect(applyDataMigrationAsync(dataDir, options)).rejects.toThrow("changed after planning");
    injection.mockRestore();
    expect(changed).toBe(true);
    expect(await exists(source.target)).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    const changedSource = await read(source.relative);
    expect(changedSource).not.toEqual(source.content);
    await expect(recoverDataMigrationAsync(dataDir)).resolves.toMatchObject({ status: "rolled_back" });
    expect(await read(source.relative)).toEqual(changedSource);
    expect(await exists(source.target)).toBe(false);
  });

  it("detects a new source file introduced during preparation", async () => {
    const source = await writeLegacyImportFixture();
    const rename = fs.rename.bind(fs);
    let added = false;
    const injection = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!added && String(from).includes("/.staging-t-") && path.basename(String(to)).startsWith("t-")) {
        added = true;
        await writeLegacyImportFixture("interval", { taskId: "concurrent-source" });
      }
    });
    await expect(applyDataMigrationAsync(dataDir, options)).rejects.toThrow("cron/ changed after planning");
    injection.mockRestore();
    expect(await exists(source.target)).toBe(false);
    expect(await exists("timed/concurrent-source.json")).toBe(false);
    await recoverDataMigrationAsync(dataDir);
    expect(await read(source.relative)).toEqual(source.content);
    expect(await exists("cron/concurrent-source.json")).toBe(true);
  });

  it("recovers interrupted imports by removing new tasks and restoring schema 1 metadata", async () => {
    const old = await installSchemaOneFixture();
    const first = await writeLegacyImportFixture();
    const second = await writeLegacyImportFixture("interval");
    const rename = fs.rename.bind(fs);
    const injection = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(dataDir, DATA_SCHEMA_FILE)) {
        throw Object.assign(new Error("Injected disk full"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    let id: string | undefined;
    try {
      await applyDataMigrationAsync(dataDir, options);
      throw new Error("Expected interruption");
    } catch (error) {
      expect(error).toBeInstanceOf(DataMigrationError);
      id = (error as DataMigrationError).transactionId;
    }
    injection.mockRestore();
    expect(id).toMatch(/^t-/);
    expect(await exists(first.target)).toBe(true);
    expect(await exists(second.target)).toBe(true);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(true);
    await expect(planDataMigrationAsync(dataDir, options)).rejects.toThrow("incomplete");
    await recoverDataMigrationAsync(dataDir);
    expect(await exists(first.target)).toBe(false);
    expect(await exists(second.target)).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect(await read(DATA_SCHEMA_FILE)).toEqual(old.marker);
    expect(await read(first.relative)).toEqual(first.content);
    expect(await read(second.relative)).toEqual(second.content);
    expect(await read(transactionPath(old.id, "journal.json"))).toEqual(old.originalJournal);
  });

  it("refuses to remove newer edits to imported tasks during rollback", async () => {
    const source = await writeLegacyImportFixture();
    const receipt = await applyDataMigrationAsync(dataDir, options);
    await fs.appendFile(path.join(dataDir, source.target), " ");
    const before = await snapshotManaged();
    await expect(rollbackDataMigrationAsync(dataDir, receipt.transactionId!)).rejects.toThrow("discard newer data");
    expect(await snapshotManaged()).toEqual(before);
    expect(await read(source.relative)).toEqual(source.content);
  });

  it("rolls back unchanged imported tasks and tracking metadata while preserving their sources", async () => {
    const source = await writeLegacyImportFixture();
    const receipt = await applyDataMigrationAsync(dataDir, options);
    await rollbackDataMigrationAsync(dataDir, receipt.transactionId!);
    expect(await exists(source.target)).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    expect(await read(source.relative)).toEqual(source.content);
    expect((await fs.stat(path.join(dataDir, source.relative))).mode & 0o777).toBe(0o640);
  });
});

describe("schema 1 compatibility", () => {
  it("upgrades a historical schema 1 journal, restores it exactly, and can then roll it back", async () => {
    const old = await installSchemaOneFixture();
    const plan = await planDataMigrationAsync(dataDir);
    expect(plan).toMatchObject({ fromVersion: 1, toVersion: 2, legacyTasksToImport: 0 });
    expect(plan.changes.map(change => change.path)).toEqual([LEGACY_IMPORTS_FILE, DATA_SCHEMA_FILE]);
    const id = await requireApplied();
    expect(await readJson(LEGACY_IMPORTS_FILE)).toEqual({ formatVersion: 1, entries: [] });
    expect((await journal(id)).sequence).toBe(2);
    expect(await read(transactionPath(old.id, "journal.json"))).toEqual(old.originalJournal);
    await rollbackDataMigrationAsync(dataDir, id);
    expect(await read(DATA_SCHEMA_FILE)).toEqual(old.marker);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    await rollbackDataMigrationAsync(dataDir, old.id);
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
  });

  it("recovers a historical interrupted schema 1 transaction", async () => {
    const old = await installSchemaOneFixture();
    const pending = JSON.parse(old.originalJournal.toString("utf8"));
    pending.status = "applying";
    await fs.writeFile(path.join(dataDir, transactionPath(old.id, "journal.json")), JSON.stringify(pending));
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("incomplete");
    await expect(recoverDataMigrationAsync(dataDir)).resolves.toMatchObject({ status: "rolled_back", transactionId: old.id });
    expect(await exists(DATA_SCHEMA_FILE)).toBe(false);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
  });

  it("establishes only an empty ledger and marker when starting a compatible schema 1 installation", async () => {
    await installSchemaOneFixture();
    const runtime = await prepareRuntimeDataAsync(dataDir);
    try {
      expect(await readJson(LEGACY_IMPORTS_FILE)).toEqual({ formatVersion: 1, entries: [] });
      expect((await readJson(DATA_SCHEMA_FILE)).schemaVersion).toBe(2);
      expect(await exists("timed")).toBe(false);
    } finally {
      await runtime.releaseAsync();
    }
  });
});

async function historicalRuntime(): Promise<string> {
  const fixtureRoot = new URL("../../fixtures/migrations/schema1-runtime/", import.meta.url);
  const provenance = JSON.parse(await fs.readFile(new URL("source.json", fixtureRoot), "utf8"));
  expect(provenance.commit).toBe("d00c480b5e9b0381b430e8f6a3c89ec269238f6a");
  const directory = path.join(temporaryRoot, "schema1-runtime");
  await fs.mkdir(directory, { recursive: true });
  for (const [relative, expectedHash] of Object.entries(provenance.files)) {
    const content = await fs.readFile(new URL(relative, fixtureRoot));
    expect(crypto.createHash("sha256").update(content).digest("hex")).toBe(expectedHash);
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await fs.symlink(fileURLToPath(new URL("../../../node_modules", import.meta.url)), path.join(directory, "node_modules"));
  return directory;
}

async function runHistoricalCli(runtime: string, command: string, extra: string[] = []): Promise<{ code: number; output: Record<string, any> }> {
  try {
    const result = await execFileAsync(process.execPath, [
      "--import", "tsx", path.join(runtime, "src/migrations/cli.ts"), command, "--data-dir", dataDir, ...extra,
    ], { cwd: runtime, timeout: 15_000, env: { ...process.env, BLACKDOGBOT_DATA_DIR: dataDir } });
    return { code: 0, output: JSON.parse(result.stdout) };
  } catch (error) {
    const result = error as { code: number; stdout: string };
    return { code: result.code, output: JSON.parse(result.stdout) };
  }
}

describe("rollback compatibility with the actual schema 1 release", () => {
  it("preserves retired evidence and passes the d00c480 CLI and runtime startup gate after rollback", async () => {
    const old = await installSchemaOneFixture();
    const runtime = await historicalRuntime();
    const id = await requireApplied();
    await rollbackDataMigrationAsync(dataDir, id);

    expect(await read(DATA_SCHEMA_FILE)).toEqual(old.marker);
    expect(await exists(transactionPath(id, "journal.json"))).toBe(false);
    expect(await exists(RETIRED_TRANSACTIONS_DIR + "/" + id + "/journal.json")).toBe(true);
    expect((await journal(id)).status).toBe("rolled_back");
    expect(await fs.readFile(path.join(dataDir, RETIRED_TRANSACTIONS_DIR, id, "0001.before"))).toEqual(old.marker);
    const plan = await runHistoricalCli(runtime, "plan");
    expect(plan.code).toBe(0);
    expect(plan.output).toMatchObject({ fromVersion: 1, toVersion: 1, needsMigration: false });

    const script = [
      'import { pathToFileURL } from "node:url";',
      'const { prepareRuntimeDataAsync } = await import(pathToFileURL(' + JSON.stringify(path.join(runtime, "src/migrations/data-migrations.ts")) + '));',
      'const lock = await prepareRuntimeDataAsync(' + JSON.stringify(dataDir) + ');',
      'await lock.releaseAsync();',
      'process.stdout.write(JSON.stringify({ ready: true }));',
    ].join("\n");
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: runtime, timeout: 15_000, env: { ...process.env, BLACKDOGBOT_DATA_DIR: dataDir },
    });
    expect(JSON.parse(result.stdout)).toEqual({ ready: true });
    expect(await exists(".migrations/lock.json")).toBe(false);
    expect(await read(DATA_SCHEMA_FILE)).toEqual(old.marker);
    await expect(rollbackDataMigrationAsync(dataDir, id)).resolves.toMatchObject({ status: "rolled_back", transactionId: id });
  });

  it("recovers an interruption before retiring a completed rollback", async () => {
    const old = await installSchemaOneFixture();
    const runtime = await historicalRuntime();
    const id = await requireApplied();
    const active = path.join(dataDir, ".migrations", "transactions", id);
    const rename = fs.rename.bind(fs);
    const injected = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === active) throw Object.assign(new Error("Injected retirement failure"), { code: "EIO" });
      return rename(from, to);
    });
    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("retirement is incomplete");
    injected.mockRestore();
    expect(await read(DATA_SCHEMA_FILE)).toEqual(old.marker);
    expect(await exists(LEGACY_IMPORTS_FILE)).toBe(false);
    expect((await journal(id)).status).toBe("rolled_back");
    await expect(planDataMigrationAsync(dataDir)).rejects.toThrow("retirement is incomplete");
    expect((await runHistoricalCli(runtime, "plan")).code).toBe(1);

    await expect(recoverDataMigrationAsync(dataDir)).resolves.toMatchObject({ status: "rolled_back", transactionId: id });
    expect(await exists(transactionPath(id, "journal.json"))).toBe(false);
    expect(await exists(RETIRED_TRANSACTIONS_DIR + "/" + id + "/journal.json")).toBe(true);
    expect((await runHistoricalCli(runtime, "plan")).code).toBe(0);
  });

  it("can retry rollback after retirement moved the receipt but did not finish syncing", async () => {
    await installSchemaOneFixture();
    const id = await requireApplied();
    const retired = path.join(dataDir, RETIRED_TRANSACTIONS_DIR, id);
    const rename = fs.rename.bind(fs);
    const injected = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to) === retired) throw Object.assign(new Error("Injected post-rename failure"), { code: "EIO" });
    });
    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("retirement is incomplete");
    injected.mockRestore();
    expect(await exists(transactionPath(id, "journal.json"))).toBe(false);
    expect(await exists(RETIRED_TRANSACTIONS_DIR + "/" + id + "/journal.json")).toBe(true);
    await expect(rollbackDataMigrationAsync(dataDir, id)).resolves.toMatchObject({ status: "rolled_back" });
    await expect(recoverDataMigrationAsync(dataDir)).resolves.toMatchObject({ status: "unchanged" });
  });

  it("retires all future-schema receipts after later same-version transactions were rolled back", async () => {
    await installSchemaOneFixture();
    const baseline = await requireApplied();
    await writeTask("later", "modern-before-dedup");
    const later = await requireApplied();
    await rollbackDataMigrationAsync(dataDir, later);
    expect(await exists(transactionPath(later, "journal.json"))).toBe(true);
    await rollbackDataMigrationAsync(dataDir, baseline);
    expect(await exists(transactionPath(later, "journal.json"))).toBe(false);
    expect(await exists(transactionPath(baseline, "journal.json"))).toBe(false);
    expect(await exists(RETIRED_TRANSACTIONS_DIR + "/" + later + "/journal.json")).toBe(true);
    expect(await exists(RETIRED_TRANSACTIONS_DIR + "/" + baseline + "/journal.json")).toBe(true);
    const runtime = await historicalRuntime();
    const plan = await runHistoricalCli(runtime, "plan");
    expect(plan.code).toBe(0);
    expect(plan.output).toMatchObject({ fromVersion: 1, toVersion: 1, needsMigration: true });
  });

  it("keeps retired sequence numbers separate from new transactions created by old code", async () => {
    await installSchemaOneFixture();
    const runtime = await historicalRuntime();
    const retiredId = await requireApplied();
    expect((await journal(retiredId)).sequence).toBe(2);
    await rollbackDataMigrationAsync(dataDir, retiredId);
    await writeTask("old-code-edit", "modern-before-dedup");
    const oldApplied = await runHistoricalCli(runtime, "apply", ["--offline"]);
    expect(oldApplied.code).toBe(0);
    expect(oldApplied.output.status).toBe("applied");
    expect((await journal(oldApplied.output.transactionId)).sequence).toBe(2);

    const next = await requireApplied();
    expect((await journal(next)).sequence).toBe(3);
    expect(await exists(RETIRED_TRANSACTIONS_DIR + "/" + retiredId + "/journal.json")).toBe(true);
    expect((await planDataMigrationAsync(dataDir)).needsMigration).toBe(false);
  });

  it("refuses an old task-only rollback against a newer schema before modifying any file", async () => {
    await requireApplied();
    await writeTask("task-only", "modern-before-dedup");
    const id = await requireApplied();
    await fs.writeFile(path.join(dataDir, DATA_SCHEMA_FILE),
      JSON.stringify({ formatVersion: 1, schemaVersion: 3, components: { timedTasks: 1, legacyCronImports: 1, future: 1 } }));
    const before = await snapshotManaged();
    await expect(rollbackDataMigrationAsync(dataDir, id)).rejects.toThrow("newer release");
    expect(await snapshotManaged()).toEqual(before);
  });
});
