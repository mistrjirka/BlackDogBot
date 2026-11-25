import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";
import { createDataBackupAsync } from "../../../src/migrations/data-backups.js";
import { applyBackupRetentionAsync, planBackupRetentionAsync } from "../../../src/migrations/backup-retention.js";

let root: string;
let data: string;
let backups: string;
let state: string;
const now = new Date("2026-11-25T12:00:00.000Z");
const revision = "a".repeat(40);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-retention-"));
  data = path.join(root, "data");
  backups = path.join(root, "backups");
  state = path.join(root, "state");
  await writeTestConfigAsync(path.join(data, "config.yaml"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
function options() { return { dataDir: data, backupRoot: backups, stateDir: state, keep: 2, minAgeDays: 14, now }; }
async function snapshot(name: string, days: number, source = data): Promise<string> {
  const destination = path.join(backups, name);
  await createDataBackupAsync(source, destination);
  const manifestFile = path.join(destination, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.createdAt = new Date(now.getTime() - days * 86400000).toISOString();
  const content = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(manifestFile, content);
  await fs.writeFile(path.join(destination, "manifest.sha256"), crypto.createHash("sha256").update(content).digest("hex") + "\n");
  return destination;
}
async function report(name: string, value: object, modified = Date.now()): Promise<void> {
  const file = path.join(state, "reports", name + ".json");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await fs.utimes(file, modified / 1000, modified / 1000);
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function baseline(): Promise<string[]> {
  const paths: string[] = [];
  for (const [name, age] of [["oldest", 120], ["old", 90], ["middle", 30], ["newest", 1]] as const) {
    paths.push(await snapshot(name, age));
  }
  return paths;
}

describe("verified backup retention", () => {
  it("refuses cleanup while a guarded deployment holds its lock", async () => {
    const [oldest, old] = await baseline();
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    const helper = fileURLToPath(new URL("../../../scripts/hold-deploy-lock.py", import.meta.url));
    const holder = spawn("python3", [helper, state], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const [ready] = await once(holder.stdout, "data");
      expect(ready.toString()).toBe("locked\n");
      await expect(applyBackupRetentionAsync(options())).rejects.toThrow("An upgrade may be running");
      expect(await exists(oldest)).toBe(true);
      expect(await exists(old)).toBe(true);
    } finally {
      holder.stdin.end();
      await once(holder, "close");
    }
  });
  it("also blocks cleanup through another supervisor state directory", async () => {
    const [oldest] = await baseline();
    const otherState = path.join(root, "another-state");
    const activation = path.join(data, "deploy");
    await fs.mkdir(otherState, { recursive: true, mode: 0o700 });
    await fs.mkdir(activation, { recursive: true, mode: 0o700 });
    const helper = fileURLToPath(new URL("../../../scripts/hold-deploy-lock.py", import.meta.url));
    const holder = spawn("python3", [helper, otherState, activation], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await once(holder.stdout, "data");
      await expect(applyBackupRetentionAsync(options())).rejects.toThrow("An upgrade may be running");
      expect(await exists(oldest)).toBe(true);
    } finally {
      holder.stdin.end();
      await once(holder, "close");
    }
  });

  it("previews without adding locks, receipts, or changing snapshots", async () => {
    const [oldest, old] = await baseline();
    const names = await fs.readdir(backups);
    const hashes = await Promise.all(names.map(name => fs.readFile(path.join(backups, name, "manifest.sha256"), "utf8")));
    const plan = await planBackupRetentionAsync(options());
    expect(plan.remove.map(item => item.backupPath)).toEqual([old, oldest]);
    expect(plan.removableBytes).toBeGreaterThan(0);
    expect(await fs.readdir(backups)).toEqual(names);
    expect(await Promise.all(names.map(name => fs.readFile(path.join(backups, name, "manifest.sha256"), "utf8")))).toEqual(hashes);
    expect(await exists(path.join(backups, ".migrations"))).toBe(false);
  });

  it.each(["healthy", "bootstrap_healthy"])("keeps current-release %s recovery evidence even after a preparation error", async status => {
    const [oldest, old, middle, newest] = await baseline();
    await fs.mkdir(state, { recursive: true });
    await fs.symlink(path.join(state, "releases", revision), path.join(state, "current"));
    await report("healthy", { status, revision, backup: { backupPath: oldest } }, 1000);
    await report("latest", { status: "prepare_failed", revision: "b".repeat(40) }, 2000);
    const result = await applyBackupRetentionAsync(options());
    expect(result.status).toBe("applied");
    expect(result.removed.map(item => item.backupPath)).toEqual([old]);
    for (const file of [oldest, middle, newest]) expect(await exists(file)).toBe(true);
    expect(await exists(old)).toBe(false);
    if ("receiptPath" in result) {
      const receipt = JSON.parse(await fs.readFile(result.receiptPath, "utf8"));
      expect(receipt.status).toBe("completed");
      expect(receipt.removed).toHaveLength(1);
      expect((await fs.stat(result.receiptPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves the current restored release using the supervisor's rollback receipt", async () => {
    const [oldest] = await baseline();
    await fs.mkdir(state);
    await fs.symlink(path.join(state, "legacy-baselines", revision), path.join(state, "current"));
    await report("rolled-back", { status: "rolled_back", restored_revision: revision, backup: { backupPath: oldest } }, 1000);
    await report("latest", { status: "prepare_failed", revision: "b".repeat(40) }, 2000);
    const plan = await planBackupRetentionAsync(options());
    expect(plan.retain).toContainEqual({ backupPath: oldest, reason: "current-or-unresolved-deployment" });
    expect(plan.remove.map(item => item.backupPath)).not.toContain(oldest);
  });

  it("retains unresolved migrations and the latest backup regardless of age", async () => {
    const [oldest, old] = await baseline();
    await report("failed", { status: "migration_failed", backup: { backupPath: oldest } }, 1000);
    await report("latest", { status: "healthy", backup: { backupPath: old } }, 2000);
    const plan = await planBackupRetentionAsync(options());
    expect(plan.remove).toEqual([]);
    expect(plan.retain.filter(item => item.reason === "current-or-unresolved-deployment").map(item => item.backupPath).sort()).toEqual([old, oldest].sort());
  });

  it("does not permanently protect a completed deployment's earlier backup_ready report", async () => {
    const [oldest, , , newest] = await baseline();
    await report("pending", { status: "backup_ready", backup: { backupPath: oldest } }, 1000);
    await report("completed", { status: "healthy", backup: { backupPath: oldest } }, 2000);
    await report("latest", { status: "healthy", backup: { backupPath: newest } }, 3000);
    const plan = await planBackupRetentionAsync(options());
    expect(plan.remove.map(item => item.backupPath)).toContain(oldest);
  });

  it("keeps all young snapshots even when their count exceeds the minimum", async () => {
    const old = await snapshot("old", 90);
    const young = await snapshot("young", 7);
    await snapshot("newer", 2);
    await snapshot("newest", 1);
    const plan = await planBackupRetentionAsync(options());
    expect(plan.remove.map(item => item.backupPath)).toEqual([old]);
    expect(plan.retain).toContainEqual({ backupPath: young, reason: "within-minimum-age" });
  });

  it("preserves damaged backups without counting them toward verified keepers", async () => {
    const [oldest, old, middle, newest] = await baseline();
    await fs.writeFile(path.join(newest, "payload", "config.yaml"), "damaged");
    const plan = await planBackupRetentionAsync(options());
    expect(plan.remove.map(item => item.backupPath)).toEqual([oldest]);
    expect(plan.retain).toContainEqual({ backupPath: newest, reason: "verification-failed-preserved" });
    expect(plan.retain.map(item => item.backupPath)).toEqual(expect.arrayContaining([old, middle]));
  });

  it("preserves other installations, unknown directories, symlinks and interrupted cleanup evidence", async () => {
    await baseline();
    const otherData = path.join(root, "other-data");
    await writeTestConfigAsync(path.join(otherData, "config.yaml"));
    const foreign = await snapshot("foreign", 200, otherData);
    const unknown = path.join(backups, "manual-files");
    await fs.mkdir(unknown);
    await fs.writeFile(path.join(unknown, "keep.txt"), "keep");
    const link = path.join(backups, "link");
    await fs.symlink(unknown, link);
    const retired = path.join(backups, ".retiring-interrupted");
    await fs.mkdir(retired);
    await fs.writeFile(path.join(retired, "original"), "recover me");
    await applyBackupRetentionAsync(options());
    expect(await exists(foreign)).toBe(true);
    expect(await fs.readFile(path.join(unknown, "keep.txt"), "utf8")).toBe("keep");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(retired, "original"), "utf8")).toBe("recover me");
  });

  it("refuses cleanup when deployment reports are corrupt", async () => {
    const paths = await baseline();
    await report("latest", { status: "healthy" });
    await fs.writeFile(path.join(state, "reports/latest.json"), "{broken private data");
    await expect(applyBackupRetentionAsync(options())).rejects.toThrow("invalid JSON");
    for (const file of paths) expect(await exists(file)).toBe(true);
  });

  it("refuses cleanup if a guarded deployment has lost its current receipt", async () => {
    const paths = await baseline();
    await fs.mkdir(state);
    await fs.symlink(path.join(state, "releases", revision), path.join(state, "current"));
    await expect(applyBackupRetentionAsync(options())).rejects.toThrow("no deployment reports");
    for (const file of paths) expect(await exists(file)).toBe(true);
  });

  it("refuses a latest preparation report when the selected release lost its backup receipt", async () => {
    const paths = await baseline();
    await fs.mkdir(state);
    await fs.symlink(path.join(state, "releases", revision), path.join(state, "current"));
    await report("latest", { status: "prepare_failed", revision: "b".repeat(40) });
    await expect(applyBackupRetentionAsync(options())).rejects.toThrow("selected release has no backup receipt");
    for (const file of paths) expect(await exists(file)).toBe(true);
  });

  it("refuses structurally incomplete deployment reports", async () => {
    await baseline();
    await report("latest", {});
    await expect(applyBackupRetentionAsync(options())).rejects.toThrow("no status");
  });

  it("preserves a retired copy if deployment evidence changes before deletion", async () => {
    await baseline();
    await report("latest", { status: "healthy" });
    const original = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = String(args[0]);
      if (!changed && file.includes(".retiring-") && file.endsWith("manifest.json")) {
        changed = true;
        await report("latest", { status: "backup_ready", revision: "new-deployment" });
      }
      return original(...args);
    });
    await expect(applyBackupRetentionAsync(options())).rejects.toThrow("Deployment evidence changed");
    expect(changed).toBe(true);
    const retired = (await fs.readdir(backups)).filter(name => name.startsWith(".retiring-"));
    expect(retired).toHaveLength(1);
    expect(await exists(path.join(backups, retired[0], "payload/config.yaml"))).toBe(true);
    const receiptDir = path.join(backups, ".retention-receipts");
    const receipt = JSON.parse(await fs.readFile(path.join(receiptDir, (await fs.readdir(receiptDir))[0]), "utf8"));
    expect(receipt.removed).toEqual([]);
    expect(receipt.quarantine).toBe(path.join(backups, retired[0]));
  });

  it.each([0, 1, -1, 1.5, Number.NaN])("rejects an unsafe keep count %s", async keep => {
    await expect(planBackupRetentionAsync({ ...options(), keep })).rejects.toThrow("at least two");
  });

  it("rejects cleanup inside runtime data", async () => {
    await expect(applyBackupRetentionAsync({ ...options(), backupRoot: path.join(data, "backups") })).rejects.toThrow("separate backup");
    expect(await exists(path.join(data, "backups"))).toBe(false);
  });

  it("returns an unchanged result without creating a missing backup directory", async () => {
    const result = await applyBackupRetentionAsync(options());
    expect(result.status).toBe("unchanged");
    expect(result.removed).toEqual([]);
    expect(await exists(backups)).toBe(false);
  });
});
