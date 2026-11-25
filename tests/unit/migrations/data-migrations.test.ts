import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";
import {
  applyDataMigrationAsync,
  DATA_SCHEMA_FILE,
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
  return readJson(transactionPath(id, "journal.json"));
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
  for (const name of [DATA_SCHEMA_FILE, "timed"]) {
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
      toVersion: 1,
      needsMigration: true,
      scope: "timed-tasks",
      config: { telegramEnabled: false, discordEnabled: false },
      timezone: "UTC",
    });
    expect(plan.changes.map(item => item.path)).toEqual([DATA_SCHEMA_FILE]);
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(await exists(".migrations")).toBe(false);
  });

  it("reports file names and reasons without returning task data or credentials", async () => {
    await writeTask();
    const before = await snapshotTree(dataDir);
    const plan = await planDataMigrationAsync(dataDir);
    const output = JSON.stringify(plan);
    expect(plan.changes.map(item => item.path)).toEqual(["timed/first.json", DATA_SCHEMA_FILE]);
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
    expect(plan.changes.map(change => change.path)).toEqual([DATA_SCHEMA_FILE]);
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(await exists("timed")).toBe(false);

    const id = await requireApplied();
    expect(await read(relative)).toEqual(content);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o640);
    expect(await exists("timed")).toBe(false);
    expect((await planDataMigrationAsync(dataDir)).preservedLegacyRecords).toBe(1);
    expect((await journal(id)).files.map((file: any) => file.path)).toEqual([DATA_SCHEMA_FILE]);

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
      formatVersion: 1, schemaVersion: 1, components: { timedTasks: 1 },
    });
    expect(await journal(id)).toMatchObject({
      status: "applied", fromVersion: 0, toVersion: 1,
    });
    expect(await read("config.yaml")).toEqual(configBefore);
    expect((await planDataMigrationAsync(dataDir)).needsMigration).toBe(false);
  });

  it("preserves exact original bytes and permissions through rollback", async () => {
    const original = await writeTask("first", "legacy-interval", 0o640);
    const configBefore = await read("config.yaml");
    const id = await requireApplied();
    const transaction = await journal(id);
    expect(transaction.files.map((item: any) => item.path)).toEqual(["timed/first.json", DATA_SCHEMA_FILE]);
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
