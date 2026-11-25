import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { acquireDataLockAsync, recoverStaleDataLockAsync } from "./data-lock.js";
import { verifyDataBackupAsync } from "./data-backups.js";

export class BackupRetentionError extends Error {
  constructor(message: string) { super(message); this.name = "BackupRetentionError"; }
}
export interface BackupRetentionOptions {
  dataDir: string;
  backupRoot?: string;
  stateDir?: string;
  keep?: number;
  minAgeDays?: number;
  now?: Date;
  recoverLock?: boolean;
}
interface Snapshot {
  backupPath: string;
  createdAt: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
}
interface KeptSnapshot { backupPath: string; reason: string }
export interface BackupRetentionPlan {
  protocolVersion: 1;
  status: "planned";
  dataDir: string;
  backupRoot: string;
  stateDir: string;
  keep: number;
  minAgeDays: number;
  remove: Snapshot[];
  retain: KeptSnapshot[];
  removableBytes: number;
  reportFingerprint: string;
}
interface InspectedPlan {
  public: BackupRetentionPlan;
  identities: Map<string, string>;
  rootIdentity: string | null;
}
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const TERMINAL = new Set(["healthy", "rolled_back", "bootstrap_healthy"]);
const publisher = fileURLToPath(new URL("../../scripts/atomic-publish.py", import.meta.url));
const exec = promisify(execFile);
const hash = (content: Buffer | string): string => crypto.createHash("sha256").update(content).digest("hex");
function fail(message: string): never { throw new BackupRetentionError(message); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(info: Stats): string { return [info.dev, info.ino, info.mode].join(":"); }
function inside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
async function safePath(value: string, label: string): Promise<string> {
  if (!path.isAbsolute(value)) fail(label + " must be an absolute path.");
  const resolved = path.resolve(value);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) fail(label + " must not contain symlinks.");
      if (current !== resolved && !info.isDirectory()) fail(label + " has a non-directory parent.");
    } catch (error) { if (missing(error)) return resolved; throw error; }
  }
  return resolved;
}
async function optionalDirectory(directory: string): Promise<Stats | null> {
  try {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("A retention directory was replaced or is not a directory.");
    return info;
  } catch (error) { if (missing(error)) return null; throw error; }
}
async function readFile(file: string, limit = 16 * 1024 * 1024): Promise<Buffer> {
  const handle = await fs.open(file, READ);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) fail("Retention metadata is not a supported regular file.");
    return await handle.readFile();
  } finally { await handle.close(); }
}
function parse(content: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(content.toString("utf8")); } catch { return fail("Retention metadata is invalid JSON. Preserve it before cleanup."); }
  if (!record(value)) return fail("Retention metadata is not an object.");
  return value;
}
async function sync(directory: string): Promise<void> {
  const handle = await fs.open(directory, READ | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeReceipt(file: string, value: unknown): Promise<void> {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); await sync(path.dirname(file)); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
async function reports(stateDir: string, backupRoot: string): Promise<{ fingerprint: string; protectedPaths: Set<string> }> {
  const directory = await safePath(path.join(stateDir, "reports"), "Deployment reports");
  const protectedPaths = new Set<string>();
  const latest = new Map<string, { modified: number; terminal: boolean }>();
  const fingerprints: string[] = [];
  let selectedRevision: string | null = null;
  try {
    const current = path.join(stateDir, "current");
    const pointer = await fs.lstat(current);
    if (!pointer.isSymbolicLink()) fail("The guarded release pointer is invalid. Cleanup was refused.");
    const target = await fs.readlink(current);
    selectedRevision = path.basename(path.resolve(stateDir, target));
    if (!/^[0-9a-f]{40}$/.test(selectedRevision)) fail("The selected release identity is invalid. Cleanup was refused.");
    fingerprints.push("current:" + identity(pointer) + ":" + target);
  } catch (error) { if (!missing(error)) throw error; }
  const info = await optionalDirectory(directory);
  if (!info) {
    try {
      await fs.lstat(path.join(stateDir, "current"));
      fail("A guarded installation has no deployment reports. Restore its recovery evidence before deleting backups.");
    } catch (error) { if (!missing(error)) throw error; }
    return { fingerprint: hash("no-reports"), protectedPaths };
  }
  let hasLatest = false;
  let selectedReceiptFound = selectedRevision === null;
  for (const name of (await fs.readdir(directory)).filter(item => item.endsWith(".json")).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("A deployment report is not a regular file. Cleanup was refused.");
    const content = await readFile(file);
    const value = parse(content);
    if (typeof value.status !== "string" || !value.status) fail("A deployment report has no status. Cleanup was refused.");
    if (value.backup !== undefined && value.backup !== null && !record(value.backup)) fail("A deployment backup reference is invalid.");
    fingerprints.push(name + ":" + stat.mtimeMs + ":" + hash(content));
    const paths: unknown[] = [];
    if (record(value.backup)) paths.push(value.backup.backupPath);
    if ("backup_path" in value) paths.push(value.backup_path);
    if (name === "latest.json") hasLatest = true;
    for (const candidate of paths) {
      if (candidate === undefined || candidate === null) continue;
      if (typeof candidate !== "string" || !path.isAbsolute(candidate)) fail("A deployment report contains an invalid backup reference.");
      const resolved = path.resolve(candidate);
      if (selectedRevision !== null && (value.revision === selectedRevision
        || (value.status === "rolled_back" && (value.previous_revision === selectedRevision || value.previous === selectedRevision || value.restored_revision === selectedRevision)))) {
        selectedReceiptFound = true;
      }
      if (path.dirname(resolved) !== backupRoot) continue;
      if (name === "latest.json"
        || (selectedRevision !== null && (value.status === "healthy" || value.status === "bootstrap_healthy") && value.revision === selectedRevision)
        || (selectedRevision !== null && value.status === "rolled_back"
          && (value.previous_revision === selectedRevision || value.previous === selectedRevision || value.restored_revision === selectedRevision))) protectedPaths.add(resolved);
      const terminal = typeof value.status === "string" && TERMINAL.has(value.status);
      const previous = latest.get(resolved);
      if (!previous || stat.mtimeMs > previous.modified || (stat.mtimeMs === previous.modified && !terminal)) {
        latest.set(resolved, { modified: stat.mtimeMs, terminal });
      }
    }
  }
  if (!hasLatest) {
    try {
      await fs.lstat(path.join(stateDir, "current"));
      fail("The current deployment receipt is missing. Restore it before deleting backups.");
    } catch (error) { if (!missing(error)) throw error; }
  }
  if (!selectedReceiptFound) fail("The selected release has no backup receipt. Restore its recovery evidence before cleanup.");
  for (const [backup, state] of latest) if (!state.terminal) protectedPaths.add(backup);
  return { fingerprint: hash(fingerprints.join("\n")), protectedPaths };
}
async function holdDeploymentLock(stateDir: string, dataDir: string) {
  await safePath(stateDir, "Deployment state");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const activationDir = await safePath(path.join(dataDir, "deploy"), "Activation state");
  await fs.mkdir(activationDir, { recursive: true, mode: 0o700 });
  const helper = fileURLToPath(new URL("../../scripts/hold-deploy-lock.py", import.meta.url));
  const child = spawn("python3", [helper, stateDir, activationDir], { stdio: ["pipe", "pipe", "ignore"] });
  let alive = true;
  const closed = new Promise<void>(resolve => child.once("close", () => { alive = false; resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new BackupRetentionError("The deployment lock did not respond.")); }, 10_000);
      let output = "";
      const stop = () => {
        clearTimeout(timer);
        reject(new BackupRetentionError("Cannot hold the deployment lock. An upgrade may be running."));
      };
      child.once("error", stop);
      child.once("exit", stop);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output === "locked\n") { clearTimeout(timer); resolve(); }
        else if (output.length > 128) { child.kill(); stop(); }
      });
    });
  } catch (error) { child.kill(); await closed; throw error; }
  return {
    assertHeld(): void {
      if (!alive || child.exitCode !== null || child.signalCode !== null) fail("The deployment lock was lost. Cleanup stopped.");
    },
    async releaseAsync(): Promise<void> { child.stdin.end(); await closed; },
  };
}
async function inspect(options: BackupRetentionOptions): Promise<InspectedPlan> {
  const dataDir = await safePath(options.dataDir, "Data directory");
  const backupRoot = await safePath(options.backupRoot ?? path.join(path.dirname(dataDir), path.basename(dataDir) + "-backups"), "Backup root");
  const stateDir = await safePath(options.stateDir ?? path.join(dataDir, "deploy"), "Deployment state");
  if (inside(dataDir, backupRoot) || inside(backupRoot, dataDir) || backupRoot === path.parse(backupRoot).root) fail("Backup cleanup must target a separate backup directory.");
  const keep = options.keep ?? 3;
  const minAgeDays = options.minAgeDays ?? 14;
  if (!Number.isSafeInteger(keep) || keep < 2 || keep > 1000) fail("--keep must retain at least two backups and at most 1000.");
  if (!Number.isFinite(minAgeDays) || minAgeDays < 1 || minAgeDays > 36500) fail("--min-age-days must be between 1 and 36500.");
  const now = options.now?.getTime() ?? Date.now();
  if (!Number.isFinite(now)) fail("The retention clock is invalid.");
  const rootStat = await optionalDirectory(backupRoot);
  if (rootStat && (rootStat.mode & 0o022)) fail("The backup root must not be writable by other users.");
  const deployment = await reports(stateDir, backupRoot);
  const snapshots: Snapshot[] = [];
  const retain: KeptSnapshot[] = [];
  const identities = new Map<string, string>();
  if (rootStat) for (const name of (await fs.readdir(backupRoot)).sort()) {
    const backupPath = path.join(backupRoot, name);
    const stat = await fs.lstat(backupPath);
    if (name.startsWith(".")) { retain.push({ backupPath, reason: "staging-or-recovery-evidence" }); continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) { retain.push({ backupPath, reason: "unrecognized-entry" }); continue; }
    try {
      const verified = await verifyDataBackupAsync(backupPath);
      if (verified.sourceDataDir !== dataDir) { retain.push({ backupPath, reason: "different-data-directory" }); continue; }
      const manifest = parse(await readFile(path.join(backupPath, "manifest.json")));
      if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) fail("Backup creation time is invalid.");
      if (hash(await readFile(path.join(backupPath, "manifest.json"))) !== verified.manifestSha256) fail("A backup changed during inspection.");
      const currentStat = await fs.lstat(backupPath);
      if (identity(currentStat) !== identity(stat)) fail("A backup directory changed during inspection.");
      identities.set(backupPath, identity(stat));
      snapshots.push({
        backupPath, createdAt: manifest.createdAt, manifestSha256: verified.manifestSha256,
        fileCount: verified.fileCount, totalBytes: verified.totalBytes,
      });
    } catch {
      retain.push({ backupPath, reason: "verification-failed-preserved" });
    }
  }
  snapshots.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.backupPath.localeCompare(b.backupPath));
  const remove: Snapshot[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    let reason: string | null = null;
    if (deployment.protectedPaths.has(snapshot.backupPath)) reason = "current-or-unresolved-deployment";
    else if (index < keep) reason = "newest-verified-backups";
    else if (now - Date.parse(snapshot.createdAt) < minAgeDays * 86_400_000) reason = "within-minimum-age";
    if (reason) retain.push({ backupPath: snapshot.backupPath, reason });
    else remove.push(snapshot);
  }
  return {
    public: {
      protocolVersion: 1, status: "planned", dataDir, backupRoot, stateDir, keep, minAgeDays,
      remove, retain, removableBytes: remove.reduce((sum, item) => sum + item.totalBytes, 0),
      reportFingerprint: deployment.fingerprint,
    },
    identities, rootIdentity: rootStat ? identity(rootStat) : null,
  };
}
export async function planBackupRetentionAsync(options: BackupRetentionOptions): Promise<BackupRetentionPlan> {
  return (await inspect(options)).public;
}
export async function applyBackupRetentionAsync(options: BackupRetentionOptions) {
  const dataDir = await safePath(options.dataDir, "Data directory");
  const backupRoot = await safePath(options.backupRoot ?? path.join(path.dirname(dataDir), path.basename(dataDir) + "-backups"), "Backup root");
  if (inside(dataDir, backupRoot) || inside(backupRoot, dataDir) || backupRoot === path.parse(backupRoot).root) fail("Backup cleanup must target a separate backup directory.");
  const rootStat = await optionalDirectory(backupRoot);
  if (!rootStat) return { ...(await inspect(options)).public, status: "unchanged" as const, removed: [], removedBytes: 0 };
  if (rootStat.mode & 0o022) fail("The backup root must not be writable by other users.");
  const deploymentLock = await holdDeploymentLock(await safePath(options.stateDir ?? path.join(dataDir, "deploy"), "Deployment state"), dataDir);
  try {
    if (options.recoverLock) await recoverStaleDataLockAsync(backupRoot);
    const lock = await acquireDataLockAsync(backupRoot, "migration");
    try {
      const inspected = await inspect(options);
      const plan = inspected.public;
      const removed: Snapshot[] = [];
      if (!plan.remove.length) return { ...plan, status: "unchanged" as const, removed, removedBytes: 0 };
      const receiptDirectory = path.join(plan.backupRoot, ".retention-receipts");
      await safePath(receiptDirectory, "Retention receipt directory");
      await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(receiptDirectory)).mode & 0o077) fail("Retention receipts must have private permissions.");
      const receiptPath = path.join(receiptDirectory, "prune-" + crypto.randomUUID() + ".json");
      const receipt = {
        protocolVersion: 1, status: "pruning", dataDir: plan.dataDir,
        plannedAt: new Date().toISOString(), keep: plan.keep, minAgeDays: plan.minAgeDays,
        planned: plan.remove, removed, quarantine: null as string | null,
      };
      await writeReceipt(receiptPath, receipt);
      for (const snapshot of plan.remove) {
        if (identity(await fs.lstat(plan.backupRoot)) !== inspected.rootIdentity) fail("The backup root changed. Cleanup stopped.");
        const currentReports = await reports(plan.stateDir, plan.backupRoot);
        if (currentReports.fingerprint !== plan.reportFingerprint) fail("Deployment reports changed. Run a new cleanup preview.");
        if (identity(await fs.lstat(snapshot.backupPath)) !== inspected.identities.get(snapshot.backupPath)) fail("A backup directory changed. Cleanup stopped.");
        const verified = await verifyDataBackupAsync(snapshot.backupPath);
        if (verified.manifestSha256 !== snapshot.manifestSha256) fail("A backup changed after the cleanup plan. It was preserved.");
        const quarantine = path.join(plan.backupRoot, ".retiring-" + crypto.randomUUID());
        receipt.quarantine = quarantine;
        await writeReceipt(receiptPath, receipt);
        try {
          const result = await exec("python3", [publisher, snapshot.backupPath, quarantine], { timeout: 30_000, maxBuffer: 65536 });
          if (parse(Buffer.from(result.stdout)).status !== "published") fail("Backup retirement did not publish its recovery directory.");
        } catch { fail("Backup retirement could not complete. Inspect its receipt before retrying: " + receiptPath); }
        const staged = await verifyDataBackupAsync(quarantine);
        if (staged.manifestSha256 !== snapshot.manifestSha256 || identity(await fs.lstat(quarantine)) !== inspected.identities.get(snapshot.backupPath)) {
          fail("A changed backup was preserved in its retirement directory. Inspect: " + receiptPath);
        }
        const finalReports = await reports(plan.stateDir, plan.backupRoot);
        if (finalReports.fingerprint !== plan.reportFingerprint) fail("Deployment evidence changed. The retired copy is preserved at " + quarantine);
        deploymentLock.assertHeld();
        await fs.rm(quarantine, { recursive: true });
        await sync(plan.backupRoot);
        removed.push(snapshot);
        receipt.quarantine = null;
        await writeReceipt(receiptPath, receipt);
      }
      receipt.status = "completed";
      await writeReceipt(receiptPath, receipt);
      return { ...plan, status: "applied" as const, removed, removedBytes: removed.reduce((sum, item) => sum + item.totalBytes, 0), receiptPath };
    } finally { await lock.releaseAsync(); }
  } finally { await deploymentLock.releaseAsync(); }
}
