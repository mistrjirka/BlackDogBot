import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTestConfigAsync } from "../../helpers/test-config.js";

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const cli = path.join(repository, "src/migrations/cli.ts");
let root: string;
let dataDir: string;
let backupDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-backup-cli-"));
  dataDir = path.join(root, "data");
  backupDir = path.join(root, "snapshot");
  await writeTestConfigAsync(path.join(dataDir, "config.yaml"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; output: Record<string, any>; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repository, timeout: 15_000,
      env: { ...process.env, BLACKDOGBOT_DATA_DIR: dataDir },
    });
    return { code: 0, output: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: JSON.parse(result.stdout), stderr: result.stderr };
  }
}

describe("backup command protocol", () => {
  it("advertises backup coverage without creating migration metadata", async () => {
    const result = await run("plan", "--data-dir", dataDir);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      protocolVersion: 1, backupProtocolVersion: 1, backupReady: true,
      backupPlan: { status: "planned", sourceDataDir: dataDir },
    });
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
    expect(JSON.stringify(result)).not.toContain("test-only-not-a-secret");
  });

  it("reports an uncovered active store before any mutation", async () => {
    const configFile = path.join(dataDir, "config.yaml");
    const config = parseYaml(await fs.readFile(configFile, "utf8"));
    config.knowledge.embeddingProvider = "local";
    config.knowledge.lancedbPath = path.join(root, "external-database");
    await fs.writeFile(configFile, stringifyYaml(config));
    const original = await fs.readFile(configFile);
    const result = await run("plan");
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({ backupProtocolVersion: 1, backupReady: false });
    expect(result.output.backupIssue).toContain("knowledge.lancedbPath");
    expect(result.output.backupIssue).toContain("outside");
    expect(await fs.readFile(configFile)).toEqual(original);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
    expect(JSON.stringify(result)).not.toContain("test-only-not-a-secret");
  });

  it.each(["backup-create", "backup-restore"])("requires offline confirmation for %s", async command => {
    const result = await run(command, "--backup-dir", backupDir);
    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({ protocolVersion: 1, status: "failed" });
    expect(result.output.error).toContain("--offline");
    expect(await fs.readdir(root)).toEqual(["data"]);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });

  it("creates, verifies, and restores only into a new staging destination", async () => {
    const session = Buffer.from('{"messages":["retain this message"]}\n');
    await fs.mkdir(path.join(dataDir, "sessions"));
    await fs.writeFile(path.join(dataDir, "sessions", "chat.json"), session, { mode: 0o640 });
    const originalConfig = await fs.readFile(path.join(dataDir, "config.yaml"));
    const created = await run("backup-create", "--data-dir", dataDir, "--backup-dir", backupDir, "--offline");
    expect(created.code).toBe(0);
    expect(created.output).toMatchObject({ protocolVersion: 1, status: "created", backupPath: backupDir });
    const verified = await run("backup-verify", "--backup-dir", backupDir);
    expect(verified.code).toBe(0);
    expect(verified.output).toMatchObject({
      status: "verified", manifestSha256: created.output.manifestSha256,
    });
    const destination = path.join(root, "restored");
    const restored = await run("backup-restore", "--backup-dir", backupDir, "--destination", destination, "--offline");
    expect(restored.code).toBe(0);
    expect(restored.output).toMatchObject({ status: "restored", destination, sourceDataDir: dataDir });
    expect(await fs.readFile(path.join(destination, "config.yaml"))).toEqual(originalConfig);
    expect(await fs.readFile(path.join(destination, "sessions", "chat.json"))).toEqual(session);
    expect((await fs.stat(path.join(destination, "sessions", "chat.json"))).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(path.join(dataDir, "sessions", "chat.json"))).toEqual(session);
    expect(JSON.stringify([created, verified, restored])).not.toContain("test-only-not-a-secret");

    const repeated = await run("backup-restore", "--backup-dir", backupDir, "--destination", destination, "--offline");
    expect(repeated.code).toBe(1);
    expect(repeated.output.status).toBe("failed");
    expect(await fs.readFile(path.join(destination, "sessions", "chat.json"))).toEqual(session);

    const emptyDestination = path.join(root, "already-empty");
    await fs.mkdir(emptyDestination);
    const emptyRestore = await run("backup-restore", "--backup-dir", backupDir, "--destination", emptyDestination, "--offline");
    expect(emptyRestore.code).toBe(1);
    expect(await fs.readdir(emptyDestination)).toEqual([]);
  });

  it.each([
    ["backup-verify", "--data-dir", "/unused"],
    ["backup-restore", "--offline", "--import-legacy-tasks"],
    ["backup-create", "--offline", "--destination", "/unused"],
  ])("rejects options for the wrong command: %s %s", async (...args) => {
    const result = await run(...args);
    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({ protocolVersion: 1, status: "failed" });
    expect(await fs.readdir(root)).toEqual(["data"]);
    expect(await fs.readdir(dataDir)).toEqual(["config.yaml"]);
  });
});
