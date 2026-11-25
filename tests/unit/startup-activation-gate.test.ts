import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StartupActivationGate, validateStartupMessagingAsync } from "../../src/services/startup-activation-gate.js";
import type { IConfig } from "../../src/shared/types/index.js";

const revision = "a".repeat(40);
const nonce = "b".repeat(32);
const invocation = "c".repeat(32);
let root: string;
let data: string;
let candidate: string;
let approval: Record<string, unknown>;

async function privateFile(name: string, value: unknown): Promise<void> {
  await fs.mkdir(path.join(data, "deploy"), { recursive: true });
  await fs.writeFile(path.join(data, "deploy", name), JSON.stringify(value), { mode: 0o600 });
}
async function commit(overrides: Record<string, unknown> = {}, release = true): Promise<void> {
  approval = { ...approval, status: "committed", runtimePid: process.pid, invocationId: invocation, ...overrides };
  await privateFile("activation.json", approval);
  if (release) await privateFile("activation-release.json", approval);
}
async function gate(): Promise<StartupActivationGate> {
  return StartupActivationGate.createAsync(data, { releaseRoot: candidate, invocationId: invocation, pollIntervalMs: 2 });
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdog-activation-"));
  data = path.join(root, "data");
  candidate = path.join(root, "releases", revision);
  await fs.mkdir(candidate, { recursive: true });
  approval = { protocolVersion: 1, status: "pending", nonce, revision, candidatePath: candidate,
    dataDir: data, createdAt: new Date().toISOString() };
  await privateFile("activation.json", approval);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { force: true, recursive: true }); });

describe("guarded runtime activation", () => {
  it("holds all continuation until durable acceptance and a separate release signal", async () => {
    const runtime = await gate();
    await runtime.markReadyAsync();
    const ready = JSON.parse(await fs.readFile(path.join(data, "deploy/activation-ready.json"), "utf8"));
    expect(ready).toMatchObject({ status: "pending", nonce, pid: process.pid, invocationId: invocation });
    let externalWork = 0;
    const work = runtime.waitForAcceptanceAsync().then(() => { externalWork += 1; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(externalWork).toBe(0);
    await commit({}, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(externalWork).toBe(0);
    await privateFile("activation-release.json", approval);
    await work;
    expect(externalWork).toBe(1);
    await runtime.markActiveAsync();
    expect(JSON.parse(await fs.readFile(path.join(data, "deploy/activation-ready.json"), "utf8")).status).toBe("active");
  });

  it("keeps a crash after commitment and before release gated on restart", async () => {
    await commit({ runtimePid: process.pid + 1 }, false);
    const runtime = await gate();
    expect(runtime.isPending()).toBe(true);
    await runtime.markReadyAsync();
    const waiting = runtime.waitForAcceptanceAsync();
    await commit();
    await waiting;
    expect(runtime.isPending()).toBe(false);
  });

  it("permits normal automatic restarts after accepted activation", async () => {
    await commit({ runtimePid: process.pid + 1, invocationId: "d".repeat(32) });
    const runtime = await gate();
    expect(runtime.isPending()).toBe(false);
    await runtime.markActiveAsync();
    const ready = JSON.parse(await fs.readFile(path.join(data, "deploy/activation-ready.json"), "utf8"));
    expect(ready).toMatchObject({ status: "active", pid: process.pid, invocationId: invocation });
  });

  it("refuses an acceptance bound to a different invocation", async () => {
    const runtime = await gate();
    const waiting = runtime.waitForAcceptanceAsync();
    const rejected = expect(waiting).rejects.toThrow("different runtime invocation");
    await commit({ invocationId: "d".repeat(32) });
    await rejected;
  });

  it("refuses an acceptance bound to a different process", async () => {
    const runtime = await gate();
    const waiting = runtime.waitForAcceptanceAsync();
    const rejected = expect(waiting).rejects.toThrow("different runtime invocation");
    await commit({ runtimePid: process.pid + 1 });
    await rejected;
  });

  it("does not enable work if the approval disappears", async () => {
    const runtime = await gate();
    await fs.unlink(path.join(data, "deploy/activation.json"));
    await expect(runtime.waitForAcceptanceAsync()).rejects.toThrow("changed while waiting");
    await expect(runtime.markActiveAsync()).rejects.toThrow("not been accepted");
  });

  it("refuses stale or replaced approval nonces", async () => {
    const runtime = await gate();
    await privateFile("activation.json", { ...approval, nonce: "f".repeat(32) });
    await expect(runtime.waitForAcceptanceAsync()).rejects.toThrow("changed while waiting");
  });

  it("requires approval for prepared releases but allows fresh direct source startup", async () => {
    await fs.unlink(path.join(data, "deploy/activation.json"));
    await expect(gate()).rejects.toThrow("no matching activation approval");
    const source = path.join(root, "source");
    await fs.mkdir(source);
    expect((await StartupActivationGate.createAsync(data, { releaseRoot: source })).isPending()).toBe(false);
  });

  it("blocks other code while an upgrade is pending", async () => {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await expect(StartupActivationGate.createAsync(data, { releaseRoot: source })).rejects.toThrow("another release is pending");
  });

  it("refuses public or linked approval files", async () => {
    const file = path.join(data, "deploy/activation.json");
    await fs.chmod(file, 0o644);
    await expect(gate()).rejects.toThrow("private regular file");
    await fs.rename(file, file + ".saved");
    await fs.symlink(file + ".saved", file);
    await expect(gate()).rejects.toThrow("symlink");
  });

  it("requires a managed invocation while pending and honors cancellation", async () => {
    await expect(StartupActivationGate.createAsync(data, { releaseRoot: candidate, invocationId: "" })).rejects.toThrow("managed systemd invocation");
    const controller = new AbortController();
    const runtime = await StartupActivationGate.createAsync(data, {
      releaseRoot: candidate, invocationId: invocation, signal: controller.signal,
    });
    controller.abort();
    await expect(runtime.waitForAcceptanceAsync()).rejects.toThrow("cancelled");
  });
});

describe("read-only messaging validation", () => {
  function config(telegram = "test-only-token", discord = ""): Pick<IConfig, "telegram" | "discord"> {
    return { telegram: { botToken: telegram }, discord: { botToken: discord } } as Pick<IConfig, "telegram" | "discord">;
  }
  it("authenticates Telegram without fetching or acknowledging queued updates", async () => {
    const requests = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { id: 123 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { url: "" } })));
    await validateStartupMessagingAsync(config(), requests);
    expect(requests.mock.calls.map(call => String(call[0]).split("/").pop())).toEqual(["getMe", "getWebhookInfo"]);
    expect(requests.mock.calls.every(call => !call[1]?.body && !call[1]?.method)).toBe(true);
  });
  it("rejects an existing webhook without deleting it", async () => {
    const requests = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { id: 123 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { url: "https://example.invalid" } })));
    await expect(validateStartupMessagingAsync(config(), requests)).rejects.toThrow("existing webhook");
    expect(requests).toHaveBeenCalledTimes(2);
  });
  it("validates Discord identity without opening a gateway or changing commands", async () => {
    const requests = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "123" })));
    await validateStartupMessagingAsync(config("", "discord-test"), requests);
    expect(requests.mock.calls.map(call => call[0])).toEqual(["https://discord.com/api/v10/users/@me"]);
    expect(requests.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bot discord-test" });
  });
  it("does not leak token-containing network errors", async () => {
    const requests = vi.fn<typeof fetch>().mockRejectedValue(new Error("https://api.telegram.org/botSECRET/getMe"));
    const error = await validateStartupMessagingAsync(config("SECRET"), requests).catch(value => value as Error);
    expect(error.message).toContain("remain paused");
    expect(error.message).not.toContain("SECRET");
  });
  it("performs no requests for disabled messaging", async () => {
    const requests = vi.fn<typeof fetch>();
    await validateStartupMessagingAsync(config("", ""), requests);
    expect(requests).not.toHaveBeenCalled();
  });
});
