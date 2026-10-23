import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCmdTool } from "../../../src/tools/run-cmd.tool.js";
import { runCmdInputTool } from "../../../src/tools/run-cmd-input.tool.js";
import { getCmdOutputTool } from "../../../src/tools/get-cmd-output.tool.js";
import { getCmdStatusTool } from "../../../src/tools/get-cmd-status.tool.js";
import { waitForCmdTool } from "../../../src/tools/wait-for-cmd.tool.js";
import { stopCmdTool } from "../../../src/tools/stop-cmd.tool.js";
import { CommandProcessService } from "../../../src/services/command-process.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";

type Result = {
  status: string;
  exitCode: number | null;
  handleId: string | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  pid?: number;
  waitTimedOut?: boolean;
  completed?: boolean;
  success?: boolean;
  error?: string | null;
};
const OPTIONS = { toolCallId: "pty-test", messages: [] as never[], abortSignal: new AbortController().signal };
async function invoke<T>(tool: unknown, args: Record<string, unknown>): Promise<T> {
  const t = tool as { execute: (input: Record<string, unknown>, options: typeof OPTIONS) => Promise<T> };
  return t.execute(args, OPTIONS);
}
const sleep = async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("run_cmd single PTY backend", () => {
  let cwd: string;
  const handles = new Set<string>();

  async function run(command: string, mode: "foreground" | "background" = "foreground", timeout = mode === "background" ? 0 : 5000): Promise<Result> {
    const result = await invoke<Result>(runCmdTool, { command, cwd, mode, timeout });
    if (result.handleId) handles.add(result.handleId);
    return result;
  }

  async function output(handleId: string): Promise<Result> {
    return invoke<Result>(getCmdOutputTool, { handleId, channel: "both", maxBytes: 65536 });
  }

  async function input(handleId: string, text: string, appendNewline = true): Promise<Result> {
    return invoke<Result>(runCmdInputTool, { handleId, input: text, appendNewline, closeStdin: false });
  }

  async function waitForOutput(handleId: string, needle: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const r = await output(handleId);
      if (r.stdout.includes(needle)) return r.stdout;
      await sleep(50);
    }
    throw new Error("PTY did not emit " + needle + ": " + (await output(handleId)).stdout);
  }

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "blackdog-pty-"));
    resetSingletons();
    const logger = LoggerService.getInstance();
    await logger.initializeAsync("info", path.join(cwd, "logs"));
    silenceLogger(logger);
  });

  afterEach(async () => {
    const service = CommandProcessService.getInstance();
    for (const handleId of handles) {
      if (service.getStatus(handleId).status === "running" || service.getStatus(handleId).status === "awaiting_input") {
        await service.stopAsync(handleId, "SIGKILL");
      }
      service.removeHandle(handleId);
    }
    handles.clear();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("supplies a real terminal and merges command stdout/stderr", async () => {
    const r = await run("test -t 0 && test -t 1 && echo OUT && echo ERR >&2");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OUT");
    expect(r.stdout).toContain("ERR");
    expect(r.stderr).toBe("");
  });

  it("initializes terminal dimensions for full-screen applications", async () => {
    const r = await run("stty size");
    expect(r.status).toBe("completed");
    expect(r.stdout.trim()).toBe("40 120");
  });

  it("preserves non-zero command exit status", async () => {
    const r = await run("exit 7");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(7);
  });

  it("retains filesystem changes across fresh shells", async () => {
    const a = await run("echo persisted > artifact.txt");
    const b = await run("cat artifact.txt");
    expect(a.exitCode).toBe(0);
    expect(b.stdout).toContain("persisted");
  });

  it("accepts multiple inputs in one live interactive process", async () => {
    const r = await run("python3 -u -c 'a=input(\"Name: \"); print(\"one=\"+a,flush=True); b=input(\"Next: \"); print(\"two=\"+b,flush=True)'", "background");
    expect(r.status).toBe("running");
    const h = r.handleId!;
    await waitForOutput(h, "Name:");
    expect((await input(h, "alpha")).success).toBe(true);
    await waitForOutput(h, "Next:");
    expect((await input(h, "beta")).success).toBe(true);
    const result = await invoke<Result>(waitForCmdTool, { handleId: h, timeoutMs: 4000, maxBytes: 65536 });
    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("one=alpha");
    expect(result.stdout).toContain("two=beta");
  });

  it("allows raw terminal Ctrl+C without an appended newline", async () => {
    const r = await run("python3 -u -c 'import time; print(\"ready\",flush=True); time.sleep(30)'", "background", 0);
    const h = r.handleId!;
    await waitForOutput(h, "ready");
    await input(h, "\u0003", false);
    const final = await invoke<Result>(waitForCmdTool, { handleId: h, timeoutMs: 4500, maxBytes: 65536 });
    expect(final.completed).toBe(true);
    expect(final.exitCode).not.toBe(0);
  });

  it("accepts the named Ctrl+C key", async () => {
    const r = await run("python3 -u -c 'import time; print(\"ready\",flush=True); time.sleep(30)'", "background", 0);
    const h = r.handleId!;
    await waitForOutput(h, "ready");
    const sent = await invoke<Result>(runCmdInputTool, { handleId: h, controlKey: "CTRL_C" });
    expect(sent.success).toBe(true);
    const final = await invoke<Result>(waitForCmdTool, { handleId: h, timeoutMs: 4500, maxBytes: 65536 });
    expect(final.completed).toBe(true);
  });

  it("rejects conflicting input and controlKey", async () => {
    const r = await run("sleep 30", "background", 0);
    const result = await invoke<Result>(runCmdInputTool, { handleId: r.handleId, input: "text", controlKey: "CTRL_C" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("exactly one");
  });

  it("returns a handle when foreground detects an input prompt", async () => {
    const r = await run("python3 -u -c 'a=input(\"Password: \"); print(\"got=\"+a)'");
    expect(r.status).toBe("awaiting_input");
    const h = r.handleId!;
    await input(h, "answer");
    const result = await invoke<Result>(waitForCmdTool, { handleId: h, timeoutMs: 4000, maxBytes: 65536 });
    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("got=answer");
  });

  it("supports reading from the controlling terminal directly", async () => {
    const r = await run("python3 -u -c 'import sys; print(\"FromTTY: \",end=\"\",flush=True); f=open(\"/dev/tty\",\"r\"); print(\"got=\"+f.readline().strip())'", "background");
    const h = r.handleId!;
    await waitForOutput(h, "FromTTY:");
    await input(h, "confirmed");
    const result = await invoke<Result>(waitForCmdTool, { handleId: h, timeoutMs: 4000, maxBytes: 65536 });
    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("got=confirmed");
  });

  it("fails cleanly if the PTY helper is unavailable", async () => {
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      const result = await run("true");
      expect(result.status).toBe("failed");
      expect(result.error).toContain("ENOENT");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("can stop a background process", async () => {
    const r = await run("sleep 30", "background", 60000);
    const h = r.handleId!;
    const stopped = await invoke<Result>(stopCmdTool, { handleId: h, signal: "SIGTERM" });
    expect(stopped.success, JSON.stringify(stopped)).toBe(true);
  });

  it("enforces execution timeouts", async () => {
    const r = await run("sleep 30", "foreground", 400);
    expect(r.status).toBe("timed_out");
    expect(r.timedOut).not.toBe(false);
  });


  async function isRunning(pid: number): Promise<boolean> {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
    } catch (error: any) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function assertGone(pid: number): Promise<void> {
    for (let i = 0; i < 60 && await isRunning(pid); i++) await sleep(100);
    expect(await isRunning(pid), `PID ${pid} remains running`).toBe(false);
  }

  it.each(["SIGTERM", "SIGINT", "SIGKILL"])("stops a child tree using %s and verifies exact PIDs", async signal => {
    // Child ignores ordinary termination, exercising forced cleanup too.
    await fs.writeFile(path.join(cwd, "tree.py"), [
      "import os, subprocess, time",
      "p=subprocess.Popen(['python3','-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); signal.signal(signal.SIGHUP,signal.SIG_IGN); signal.signal(signal.SIGINT,signal.SIG_IGN); print(\"child-ready\",flush=True); time.sleep(120)'])",
      "print('PIDS=%d,%d' % (os.getpid(),p.pid),flush=True)",
      "time.sleep(120)",
    ].join("\n"));
    const r = await run("python3 -u tree.py", "background", 0);
    const out = await waitForOutput(r.handleId!, "child-ready");
    const pids = out.match(/PIDS=(\d+),(\d+)/)!.slice(1).map(Number);
    try {
      const stopped = await invoke<Result>(stopCmdTool, { handleId: r.handleId, signal });
      expect(stopped.success, JSON.stringify(stopped)).toBe(true);
      for (const pid of pids) await assertGone(pid);
    } finally {
      for (const pid of pids) if (await isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("a polling timeout does not stop a command or expire its execution deadline", async () => {
    const r = await run("python3 -u -c 'import os,time; print(os.getpid(),flush=True); time.sleep(120)'", "background", 0);
    const h = r.handleId!;
    const polled = await invoke<Result>(waitForCmdTool, { handleId: h, timeoutMs: 100, maxBytes: 65536 });
    expect(polled.waitTimedOut).toBe(true);
    expect(polled.timedOut).toBe(false);
    expect(polled.status).toBe("running");
    expect((await invoke<Result>(getCmdStatusTool, { handleId: h })).status).toBe("running");
  });

  it("waits across separate calls before accepting input without a deadline", async () => {
    const r = await run("python3 -u -c 'print(\"ready\",flush=True); a=input(); print(\"answer=\"+a)'", "background", 0);
    await waitForOutput(r.handleId!, "ready");
    await sleep(300);
    expect((await invoke<Result>(getCmdStatusTool, { handleId: r.handleId })).status).toBe("running");
    await input(r.handleId!, "later");
    const result = await invoke<Result>(waitForCmdTool, { handleId: r.handleId, timeoutMs: 4000, maxBytes: 65536 });
    expect(result.stdout).toContain("answer=later");
    expect(result.exitCode).toBe(0);
  });

  it("kills timeout children and drains the final output", async () => {
    const r = await run("python3 -u -c 'import os,subprocess,time; p=subprocess.Popen([\"sleep\",\"120\"]); print(\"PIDS=%d,%d\"%(os.getpid(),p.pid),flush=True); time.sleep(120)'", "background", 400);
    const out = await waitForOutput(r.handleId!, "PIDS=");
    const pids = out.match(/PIDS=(\d+),(\d+)/)!.slice(1).map(Number);
    try {
      const result = await invoke<Result>(waitForCmdTool, { handleId: r.handleId, timeoutMs: 8000, maxBytes: 65536 });
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).not.toBeNull();
      for (const pid of pids) await assertGone(pid);
    } finally {
      for (const pid of pids) if (await isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("rejects input sent to an already completed handle", async () => {
    const r = await run("true", "background", 0);
    for (let i = 0; i < 50 && (await invoke<Result>(getCmdStatusTool, { handleId: r.handleId })).status === "running"; i++) await sleep(20);
    expect((await input(r.handleId!, "unused")).success).toBe(false);
  });


  it("accepts a single raw character without newline in terminal raw mode", async () => {
    const r = await run("python3 -u -c 'import os,sys,tty; tty.setraw(sys.stdin.fileno()); print(\"raw-ready\",flush=True); c=os.read(0,1); print(\"BYTE=\"+c.hex(),flush=True)'", "background", 0);
    await waitForOutput(r.handleId!, "raw-ready");
    await input(r.handleId!, "x", false);
    const result = await invoke<Result>(waitForCmdTool, { handleId: r.handleId, timeoutMs: 4000, maxBytes: 65536 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("BYTE=78");
  });

  it("preserves UTF-8 and ANSI output, including a large output tail", async () => {
    const r = await run("python3 -u -c 'print(\"a\"*80000); print(\"Ω→café\\x1b[31mEND\\x1b[0m\")'");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Ω→café\x1b[31mEND\x1b[0m");
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(65536);
  });

  it("reports command-not-found as exit 127", async () => {
    const r = await run("__blackdog_missing_command__");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(127);
  });

  it("reports missing process handles as errors", async () => {
    const r = await invoke<Result>(getCmdStatusTool, { handleId: "does-not-exist" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("not found");
    const missingOutput = await output("does-not-exist");
    expect(missingOutput.error).toContain("not found");
    const waited = await invoke<Result>(waitForCmdTool, { handleId: "does-not-exist", timeoutMs: 100, maxBytes: 100 });
    expect(waited.completed).toBe(false);
    expect(waited.error).toBeTruthy();
  });
});
