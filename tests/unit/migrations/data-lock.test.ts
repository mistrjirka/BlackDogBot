import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync, { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DataLockError,
  acquireDataLockAsync,
  recoverStaleDataLockAsync,
} from "../../../src/migrations/data-lock.js";

let dataDir: string;
let metadataDir: string;
let lockPath: string;
let recoveryPath: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-data-lock-"));
  metadataDir = path.join(dataDir, ".migrations");
  lockPath = path.join(metadataDir, "lock.json");
  recoveryPath = path.join(metadataDir, "recovery.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function metadata(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
}

async function changeOwner(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
  const value = { ...await metadata(), ...updates };
  await fs.writeFile(lockPath, JSON.stringify(value));
  return value;
}

function deadProcessError(): NodeJS.ErrnoException {
  return Object.assign(new Error("No such process"), { code: "ESRCH" });
}

describe("exclusive data lock", () => {
  it("allows exactly one concurrent owner and can be acquired again after release", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireDataLockAsync(dataDir, "migration")),
    );
    const owners = results.filter((result) => result.status === "fulfilled");
    expect(owners).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    if (owners[0].status !== "fulfilled") throw new Error("Missing owner");
    await owners[0].value.releaseAsync();

    const runtime = await acquireDataLockAsync(dataDir, "runtime");
    expect((await metadata()).purpose).toBe("runtime");
    await runtime.releaseAsync();
    await runtime.releaseAsync();
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes private metadata and a process identity", async () => {
    const lock = await acquireDataLockAsync(dataDir, "runtime");
    expect((await fs.stat(metadataDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
    expect(await metadata()).toMatchObject({
      version: 1, pid: process.pid, hostname: os.hostname(), purpose: "runtime",
    });
    await lock.releaseAsync();
  });

  it("does not steal a dead lock during ordinary acquisition", async () => {
    await acquireDataLockAsync(dataDir, "runtime");
    await changeOwner({ pid: 12345 });
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw deadProcessError();
    });

    await expect(acquireDataLockAsync(dataDir, "migration")).rejects.toThrow(/explicit stale-lock recovery/);
    expect(probe).not.toHaveBeenCalled();
    expect((await metadata()).pid).toBe(12345);
  });

  it("preserves a replacement owner's nonce during asynchronous release", async () => {
    const oldOwner = await acquireDataLockAsync(dataDir, "runtime");
    const replacement = await changeOwner({ nonce: randomUUID() });
    await oldOwner.releaseAsync();
    expect(await metadata()).toEqual(replacement);
  });

  it("supports synchronous exit cleanup without removing a replacement owner", async () => {
    const own = await acquireDataLockAsync(dataDir, "runtime");
    own.releaseSync();
    expect(fsSync.existsSync(lockPath)).toBe(false);

    const oldOwner = await acquireDataLockAsync(dataDir, "runtime");
    const replacement = await changeOwner({ nonce: randomUUID() });
    oldOwner.releaseSync();
    expect(await metadata()).toEqual(replacement);
  });

  it("fails closed on incomplete metadata without removing it", async () => {
    await fs.mkdir(metadataDir);
    await fs.writeFile(lockPath, "{");
    await expect(acquireDataLockAsync(dataDir, "runtime")).rejects.toThrow(/Inspect .* manually/);
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/incomplete or invalid JSON/);
    expect(await fs.readFile(lockPath, "utf8")).toBe("{");
    await expect(fs.lstat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["", "/", "/."])("rejects a symlink data root with suffix %s", async (suffix) => {
    const realRoot = path.join(dataDir, "real");
    const linkedRoot = path.join(dataDir, "linked");
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, linkedRoot);
    await expect(acquireDataLockAsync(linkedRoot + suffix, "runtime")).rejects.toThrow(/not a symlink/);
    expect(await fs.readdir(realRoot)).toEqual([]);
  });

  it.each(["symlink", "file"])("rejects a %s metadata directory", async (kind) => {
    const target = path.join(dataDir, "target");
    if (kind === "symlink") {
      await fs.mkdir(target);
      await fs.symlink(target, metadataDir);
    } else {
      await fs.writeFile(metadataDir, "sentinel");
    }
    await expect(acquireDataLockAsync(dataDir, "runtime")).rejects.toThrow(/real directory/);
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/real directory/);
  });

  it("does not follow a symlink lock file", async () => {
    const target = path.join(dataDir, "sentinel.json");
    await fs.mkdir(metadataDir);
    await fs.writeFile(target, "sentinel");
    await fs.symlink(target, lockPath);

    await expect(acquireDataLockAsync(dataDir, "runtime")).rejects.toThrow(/symlink/);
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/symlink/);
    expect(await fs.readFile(target, "utf8")).toBe("sentinel");
    expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(true);
  });
});

describe("explicit stale-lock recovery", () => {
  it("refuses recovery while the actual local owner is alive", async () => {
    const owner = await acquireDataLockAsync(dataDir, "runtime");
    const original = await metadata();
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(DataLockError);
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/still running/);
    expect(await metadata()).toEqual(original);
    await owner.releaseAsync();
  });

  it("removes a validated dead local lock and releases its recovery barrier", async () => {
    await acquireDataLockAsync(dataDir, "runtime");
    await changeOwner({ pid: 12345 });
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw deadProcessError();
    });

    await recoverStaleDataLockAsync(dataDir);
    expect(probe).toHaveBeenCalledExactlyOnceWith(12345, 0);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });

    const next = await acquireDataLockAsync(dataDir, "migration");
    await next.releaseAsync();
  });

  it("treats EPERM as a potentially live owner", async () => {
    const lock = await acquireDataLockAsync(dataDir, "runtime");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Access denied"), { code: "EPERM" });
    });
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/still running or cannot be probed/);
    expect(fsSync.existsSync(lockPath)).toBe(true);
    await lock.releaseAsync();
  });

  it("refuses foreign-host recovery without probing its PID", async () => {
    await acquireDataLockAsync(dataDir, "runtime");
    await changeOwner({ hostname: "some-other-host.invalid" });
    const probe = vi.spyOn(process, "kill");
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/another host/);
    expect(probe).not.toHaveBeenCalled();
    expect(fsSync.existsSync(lockPath)).toBe(true);
  });

  it.each([0, -1, 1.5, null, "12345", 2_147_483_648])("rejects invalid PID %s without probing", async (pid) => {
    await acquireDataLockAsync(dataDir, "runtime");
    await changeOwner({ pid });
    const probe = vi.spyOn(process, "kill");
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/corrupt or unsupported/);
    expect(probe).not.toHaveBeenCalled();
    expect(fsSync.existsSync(lockPath)).toBe(true);
  });

  it("leaves a corrupt recovery barrier for manual inspection", async () => {
    await fs.mkdir(metadataDir);
    await fs.writeFile(recoveryPath, "{");

    await expect(acquireDataLockAsync(dataDir, "runtime")).rejects.toThrow(/unfinished recovery barrier/);
    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/Inspect .* manually/);
    expect(await fs.readFile(recoveryPath, "utf8")).toBe("{");
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  it("detects a recovery barrier that starts after its first check", async () => {
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (String(filePath) === lockPath && typeof flags === "number" && (flags & constants.O_EXCL) !== 0) {
        await fs.writeFile(recoveryPath, "{");
      }
      return handle;
    });

    await expect(acquireDataLockAsync(dataDir, "runtime")).rejects.toThrow(/unfinished recovery barrier/);
    expect(fsSync.existsSync(lockPath)).toBe(false);
    expect(await fs.readFile(recoveryPath, "utf8")).toBe("{");
  });

  it("preserves a replacement lock if ownership changes while checking the stale PID", async () => {
    await acquireDataLockAsync(dataDir, "runtime");
    const old = await changeOwner({ pid: 12345 });
    const replacement = { ...old, pid: process.pid, nonce: randomUUID() };
    vi.spyOn(process, "kill").mockImplementation(() => {
      fsSync.writeFileSync(lockPath, JSON.stringify(replacement));
      throw deadProcessError();
    });

    await expect(recoverStaleDataLockAsync(dataDir)).rejects.toThrow(/changed during recovery/);
    expect(await metadata()).toEqual(replacement);
    expect(fsSync.existsSync(recoveryPath)).toBe(false);
  });

  it("is a no-op when no lock exists", async () => {
    await recoverStaleDataLockAsync(dataDir);
    expect(await fs.readdir(metadataDir)).toEqual([]);
  });
});
