import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const cli = path.join(repository, "src/migrations/cli.ts");
let root: string, dataDir: string, runtimeCwd: string, source: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-path-cli-"));
  dataDir = path.join(root, "data");
  runtimeCwd = path.join(root, "old-release");
  source = path.join(runtimeCwd, "legacy-database");
  await fs.mkdir(source, { recursive: true });
  await writeTestConfigAsync(path.join(dataDir, "config.yaml"));
  const config = parse(await fs.readFile(path.join(dataDir, "config.yaml"), "utf8"));
  config.knowledge = { embeddingProvider: "local", lancedbPath: "legacy-database" };
  await fs.writeFile(path.join(dataDir, "config.yaml"), stringify(config));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function run(...args: string[]): Promise<{ code: number; output: Record<string, any>; stderr: string }> {
  try {
    const result = await exec(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repository, timeout: 15_000, env: { ...process.env, BLACKDOGBOT_DATA_DIR: dataDir },
    });
    return { code: 0, output: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: JSON.parse(result.stdout), stderr: result.stderr };
  }
}
async function changeConfig(change: (config: Record<string, any>) => void): Promise<void> {
  const file = path.join(dataDir, "config.yaml");
  const config = parse(await fs.readFile(file, "utf8"));
  change(config);
  await fs.writeFile(file, stringify(config));
}

describe("database path command protocol", () => {
  it("advertises the path and activation capabilities without needing the old cwd", async () => {
    const result = await run("--help");
    expect(result).toMatchObject({ code: 0, output: {
      protocolVersion: 1, pathMigrationProtocolVersion: 1, activationProtocolVersion: 1,
      usage: { "paths-apply": expect.stringContaining("--offline") },
    } });
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });

  it("allows only the supported path repair before a full backup", async () => {
    const before = await fs.readFile(path.join(dataDir, "config.yaml"));
    const result = await run("plan", "--runtime-cwd", runtimeCwd);
    expect(result).toMatchObject({ code: 0, output: {
      backupReady: false, preBackupMigrationReady: true, activationProtocolVersion: 1, pathMigrationProtocolVersion: 1,
      databasePathMigration: { needsMigration: true, sourcePath: source, destinationPath: path.join(dataDir, "knowledge", "lancedb") },
      postPathMigrationBackupPlan: { status: "planned", sourceDataDir: dataDir },
    } });
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
    expect(JSON.stringify(result)).not.toContain("test-only-not-a-secret");
  });

  it("does not bypass a second external mutable store", async () => {
    await changeConfig(config => { config.ai.openaiCompatible.profilesDir = path.join(root, "outside-profiles"); });
    const result = await run("plan", "--runtime-cwd", runtimeCwd);
    expect(result).toMatchObject({ code: 0, output: {
      backupReady: false, preBackupMigrationReady: false, databasePathMigration: { needsMigration: true },
    } });
    expect(result.output.postPathMigrationBackupPlan).toBeUndefined();
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });

  it("does not bypass an included symlink", async () => {
    const external = path.join(root, "external");
    await fs.mkdir(external);
    await fs.symlink(external, path.join(dataDir, "sessions"));
    const result = await run("plan", "--runtime-cwd", runtimeCwd);
    expect(result).toMatchObject({ code: 0, output: { backupReady: false, preBackupMigrationReady: false } });
    expect(result.output.postPathMigrationBackupPlan).toBeUndefined();
    expect(await fs.lstat(path.join(dataDir, "sessions")).then(stat => stat.isSymbolicLink())).toBe(true);
  });

  it("applies offline, replans with full coverage, and rolls back by receipt", async () => {
    const before = await fs.readFile(path.join(dataDir, "config.yaml"));
    const planned = await run("paths-plan", "--runtime-cwd", runtimeCwd);
    expect(planned).toMatchObject({ code: 0, output: { needsMigration: true, sourcePath: source } });
    const denied = await run("paths-apply", "--runtime-cwd", runtimeCwd);
    expect(denied).toMatchObject({ code: 1, output: { status: "failed", error: expect.stringContaining("--offline") } });
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
    const applied = await run("paths-apply", "--runtime-cwd", runtimeCwd, "--offline");
    expect(applied).toMatchObject({ code: 0, output: { status: "applied", transactionId: expect.stringMatching(/^p-/) } });
    const ready = await run("plan");
    expect(ready).toMatchObject({ code: 0, output: {
      backupReady: true, preBackupMigrationReady: false, databasePathMigration: { needsMigration: false },
    } });
    const rollback = await run("paths-rollback", "--transaction", applied.output.transactionId, "--offline");
    expect(rollback).toMatchObject({ code: 0, output: { status: "rolled_back" } });
    expect(await fs.readFile(path.join(dataDir, "config.yaml"))).toEqual(before);
    expect((await run("paths-recover", "--offline")).output.status).toBe("unchanged");
  });

  it("requires the actual runtime cwd before certifying relative data", async () => {
    const result = await run("plan");
    expect(result).toMatchObject({ code: 1, output: { status: "failed", error: expect.stringContaining("--runtime-cwd") } });
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });

  it("does not leak config values when validation fails", async () => {
    await changeConfig(config => { config.ai.provider = "test-only-not-a-secret"; });
    const result = await run("paths-plan", "--runtime-cwd", runtimeCwd);
    expect(result).toMatchObject({ code: 1, output: { status: "failed", error: expect.stringContaining("incompatible") } });
    expect(JSON.stringify(result)).not.toContain("test-only-not-a-secret");
  });


  it("returns safe candidate inventories when populated stores conflict", async () => {
    const destination = path.join(dataDir, "knowledge", "lancedb");
    await fs.mkdir(path.join(source, "knowledge.lance"));
    await fs.writeFile(path.join(source, "knowledge.lance", "manifest"), "old");
    await fs.mkdir(path.join(destination, "knowledge.lance"), { recursive: true });
    await fs.writeFile(path.join(destination, "knowledge.lance", "manifest"), "different");
    const result = await run("paths-plan", "--runtime-cwd", runtimeCwd);
    expect(result).toMatchObject({ code: 1, output: { status: "failed",
      databasePathCandidates: expect.arrayContaining([
        expect.objectContaining({ path: source, fileCount: 1 }),
        expect.objectContaining({ path: destination, fileCount: 1 }),
      ]),
    } });
    expect(JSON.stringify(result)).not.toContain("test-only-not-a-secret");
    await expect(fs.stat(path.join(dataDir, ".migrations"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["paths-plan", "--offline", "--transaction", "p-fake"],
    ["paths-recover", "--offline", "--source", "/tmp/not-used"],
    ["paths-apply", "--offline", "--import-legacy-tasks"],
  ])("rejects unsupported argument combinations %s", async (...args) => {
    expect((await run(...args)).code).toBe(1);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });
});
