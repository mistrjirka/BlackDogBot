import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { IConfig } from "../shared/types/index.js";

export const ACTIVATION_PROTOCOL_VERSION = 1;
const SHA = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const INVOCATION = /^[0-9a-f]{32}$/;
const DEFAULT_RELEASE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export class ActivationGateError extends Error {
  constructor(message: string) { super(message); this.name = "ActivationGateError"; }
}
interface Approval {
  protocolVersion: 1;
  status: "pending" | "committed";
  nonce: string;
  revision: string;
  candidatePath: string;
  dataDir: string;
  createdAt: string;
  runtimePid?: number;
  invocationId?: string;
}
export interface ActivationGateOptions {
  releaseRoot?: string;
  invocationId?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}
function fail(message: string): never { throw new ActivationGateError(message); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function checkAncestors(file: string): Promise<void> {
  let current = path.parse(file).root;
  for (const part of path.resolve(file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) fail("Activation state must not use symlink paths.");
    } catch (error) { if (missing(error)) return; throw error; }
  }
}
async function readApproval(file: string, dataDir: string): Promise<Approval | null> {
  await checkAncestors(file);
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32768 || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("Activation approval is not a private regular file owned by this user.");
    }
    let value: unknown;
    try { value = JSON.parse(await handle.readFile("utf8")); }
    catch { return fail("Activation approval is invalid. Use the upgrade command to recover it."); }
    if (!record(value) || value.protocolVersion !== 1 || !["pending", "committed"].includes(String(value.status))
      || typeof value.nonce !== "string" || !NONCE.test(value.nonce)
      || typeof value.revision !== "string" || !SHA.test(value.revision)
      || typeof value.candidatePath !== "string" || !path.isAbsolute(value.candidatePath)
      || path.resolve(value.candidatePath) !== value.candidatePath
      || value.dataDir !== dataDir || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || (value.status === "committed" && (!Number.isSafeInteger(value.runtimePid) || Number(value.runtimePid) <= 0
        || typeof value.invocationId !== "string" || !INVOCATION.test(value.invocationId)))) {
      return fail("Activation approval is incomplete or incompatible. Keep task processing stopped and recover the upgrade.");
    }
    return value as unknown as Approval;
  } finally { await handle.close(); }
}
async function releasedAsync(dataDir: string, approval: Approval): Promise<boolean> {
  const file = path.join(dataDir, "deploy", "activation-release.json");
  await checkAncestors(file);
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return false; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32768 || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("Activation release is not a private regular file owned by this user.");
    }
    let value: unknown;
    try { value = JSON.parse(await handle.readFile("utf8")); }
    catch { return fail("Activation release is invalid. Keep processing stopped and recover the upgrade."); }
    if (!record(value) || value.protocolVersion !== 1 || typeof value.nonce !== "string"
      || !NONCE.test(value.nonce) || typeof value.revision !== "string" || !SHA.test(value.revision)
      || typeof value.candidatePath !== "string" || !Number.isSafeInteger(value.runtimePid)
      || Number(value.runtimePid) <= 0 || typeof value.invocationId !== "string" || !INVOCATION.test(value.invocationId)) {
      return fail("Activation release is incomplete or incompatible.");
    }
    return approval.status === "committed" && value.nonce === approval.nonce
      && value.revision === approval.revision && value.candidatePath === approval.candidatePath
      && value.runtimePid === approval.runtimePid && value.invocationId === approval.invocationId;
  } finally { await handle.close(); }
}

async function atomicPrivate(file: string, content: string): Promise<void> {
  await checkAncestors(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), ".activation-ready-" + crypto.randomUUID());
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try {
    await fs.rename(temporary, file);
    const parent = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

/**
 * Pending upgrades may initialize local services, but may not consume messages,
 * run agents/tasks, flush outboxes, start MCP processes, or install skills.
 * Approval lives under deploy/, outside persistent-data snapshot payloads.
 */
export class StartupActivationGate {
  private accepted: boolean;
  private constructor(
    private readonly dataDir: string,
    private readonly releaseRoot: string,
    private readonly approval: Approval | null,
    private readonly options: ActivationGateOptions,
    accepted: boolean,
  ) { this.accepted = accepted; }

  public static async createAsync(dataDir: string, options: ActivationGateOptions = {}): Promise<StartupActivationGate> {
    if (!path.isAbsolute(dataDir)) fail("Activation requires an absolute data directory.");
    const root = path.resolve(dataDir);
    const releaseRoot = await fs.realpath(options.releaseRoot ?? DEFAULT_RELEASE_ROOT);
    const approval = await readApproval(path.join(root, "deploy", "activation.json"), root);
    const preparedRelease = path.basename(path.dirname(releaseRoot)) === "releases" && SHA.test(path.basename(releaseRoot));
    if (approval?.status === "pending" && approval.candidatePath !== releaseRoot) {
      fail("An upgrade of another release is pending. Complete or recover it before starting this code.");
    }
    if (preparedRelease && (!approval || approval.candidatePath !== releaseRoot
      || approval.revision !== path.basename(releaseRoot))) {
      fail("This prepared release has no matching activation approval. Use the current upgrade supervisor.");
    }
    const relevant = approval?.candidatePath === releaseRoot ? approval : null;
    const invocation = options.invocationId ?? process.env.INVOCATION_ID;
    const accepted = !relevant || (relevant.status === "committed" && await releasedAsync(root, relevant));
    if (!accepted && (!invocation || !INVOCATION.test(invocation))) {
      fail("A pending guarded release must run in its managed systemd invocation.");
    }
    return new StartupActivationGate(root, releaseRoot, relevant, { ...options, invocationId: invocation }, accepted);
  }

  public isPending(): boolean { return !this.accepted; }

  private async readinessAsync(status: "pending" | "active"): Promise<void> {
    if (!this.approval) return;
    const invocation = this.options.invocationId ?? process.env.INVOCATION_ID;
    if (!invocation || !INVOCATION.test(invocation)) {
      // Direct starts of an accepted revision have no supervisor waiting on them.
      if (status === "active" && this.accepted) return;
      fail("Systemd invocation identity is missing from activation readiness.");
    }
    await atomicPrivate(path.join(this.dataDir, "deploy", "activation-ready.json"), JSON.stringify({
      protocolVersion: 1, status, nonce: this.approval.nonce, revision: this.approval.revision,
      candidatePath: this.releaseRoot, pid: process.pid, invocationId: invocation,
      readyAt: new Date().toISOString(),
    }) + "\n");
  }

  public async markReadyAsync(): Promise<void> {
    if (!this.isPending()) return;
    await this.readinessAsync("pending");
    process.stdout.write("BLACKDOGBOT_READY activation pending\n");
  }

  public async waitForAcceptanceAsync(): Promise<void> {
    while (!this.accepted) {
      if (this.options.signal?.aborted) fail("Activation wait was cancelled before task processing started.");
      const next = await readApproval(path.join(this.dataDir, "deploy", "activation.json"), this.dataDir);
      if (!next || !this.approval || next.nonce !== this.approval.nonce
        || next.revision !== this.approval.revision || next.candidatePath !== this.releaseRoot) {
        fail("Activation approval changed while waiting. No task processing was enabled.");
      }
      if (next.status === "committed" && await releasedAsync(this.dataDir, next)) {
        if (next.runtimePid !== process.pid || next.invocationId !== this.options.invocationId) {
          fail("Activation approval belongs to a different runtime invocation.");
        }
        this.accepted = true;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs ?? 250));
    }
  }

  public async markActiveAsync(): Promise<void> {
    if (!this.accepted) fail("Activation has not been accepted.");
    await this.readinessAsync("active");
  }
}

/** Authenticate only. Never poll, acknowledge updates, create commands, or log tokens. */
export async function validateStartupMessagingAsync(
  config: Pick<IConfig, "telegram" | "discord">,
  request: typeof fetch = fetch,
): Promise<void> {
  const getJson = async (url: string, platform: string, headers?: Record<string, string>): Promise<unknown> => {
    try {
      const response = await request(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) return fail(platform + " credentials could not be validated before activation.");
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof ActivationGateError) throw error;
      return fail(platform + " startup validation failed. Task and message processing remain paused.");
    }
  };
  if (config.telegram?.botToken) {
    const base = "https://api.telegram.org/bot" + config.telegram.botToken;
    const identity = await getJson(base + "/getMe", "Telegram");
    const webhook = await getJson(base + "/getWebhookInfo", "Telegram");
    if (!record(identity) || identity.ok !== true || !record(identity.result) || !Number.isSafeInteger(identity.result.id)
      || !record(webhook) || webhook.ok !== true || !record(webhook.result)) {
      fail("Telegram returned an invalid startup validation response.");
    }
    if (webhook.result.url !== "") fail("Telegram polling has an existing webhook. Resolve it before guarded activation.");
  }
  if (config.discord?.botToken) {
    const identity = await getJson("https://discord.com/api/v10/users/@me", "Discord",
      { Authorization: "Bot " + config.discord.botToken });
    if (!record(identity) || typeof identity.id !== "string") fail("Discord returned an invalid startup validation response.");
  }
}
