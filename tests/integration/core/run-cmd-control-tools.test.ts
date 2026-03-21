import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runCmdTool } from "../../../src/tools/run-cmd.tool.js";
import { runCmdInputTool } from "../../../src/tools/run-cmd-input.tool.js";
import { getCmdStatusTool } from "../../../src/tools/get-cmd-status.tool.js";
import { getCmdOutputTool } from "../../../src/tools/get-cmd-output.tool.js";
import { stopCmdTool } from "../../../src/tools/stop-cmd.tool.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { CommandProcessService } from "../../../src/services/command-process.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";

type IRunCmdOutput = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: string;
  handleId: string | null;
  timedOut: boolean;
  durationMs: number | null;
  signal: string | null;
  deterministic: boolean;
  error: string | null;
};

type ICmdStatusToolOutput = {
  handleId: string;
  status: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  signal: string | null;
  error: string | null;
};

type ICmdOutputToolOutput = {
  handleId: string;
  stdout: string;
  stderr: string;
  totalStdoutBytes: number;
  totalStderrBytes: number;
};

type IRunCmdInputResult = {
  success: boolean;
  status: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
};

type IStopCmdOutput = {
  success: boolean;
  status: string;
  exitCode: number | null;
  error: string | null;
};

const TOOL_OPTIONS = {
  toolCallId: "tc-run-cmd-control",
  messages: [] as never[],
  abortSignal: new AbortController().signal,
};

async function execRunCmd(args: {
  command: string;
  cwd?: string;
  timeout?: number;
  mode?: string;
  deterministicInputDetection?: boolean;
}): Promise<IRunCmdOutput> {
  return await (runCmdTool as unknown as {
    execute: (input: typeof args, options: typeof TOOL_OPTIONS) => Promise<IRunCmdOutput>;
  }).execute(args, TOOL_OPTIONS);
}

async function execGetCmdStatus(handleId: string): Promise<ICmdStatusToolOutput> {
  return await (getCmdStatusTool as unknown as {
    execute: (input: { handleId: string }, options: typeof TOOL_OPTIONS) => Promise<ICmdStatusToolOutput>;
  }).execute({ handleId }, TOOL_OPTIONS);
}

async function execGetCmdOutput(args: {
  handleId: string;
  channel: "stdout" | "stderr" | "both";
  maxBytes: number;
}): Promise<ICmdOutputToolOutput> {
  return await (getCmdOutputTool as unknown as {
    execute: (input: typeof args, options: typeof TOOL_OPTIONS) => Promise<ICmdOutputToolOutput>;
  }).execute(args, TOOL_OPTIONS);
}

async function execRunCmdInput(args: {
  handleId: string;
  input: string;
  closeStdin?: boolean;
}): Promise<IRunCmdInputResult> {
  return await (runCmdInputTool as unknown as {
    execute: (input: typeof args, options: typeof TOOL_OPTIONS) => Promise<IRunCmdInputResult>;
  }).execute(args, TOOL_OPTIONS);
}

async function execStopCmd(args: {
  handleId: string;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT";
}): Promise<IStopCmdOutput> {
  return await (stopCmdTool as unknown as {
    execute: (input: typeof args, options: typeof TOOL_OPTIONS) => Promise<IStopCmdOutput>;
  }).execute(args, TOOL_OPTIONS);
}

async function waitForTerminalStatusAsync(handleId: string, timeoutMs: number): Promise<string> {
  const processService: CommandProcessService = CommandProcessService.getInstance();
  const startedAt: number = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status: string = processService.getStatus(handleId).status;

    if (status === "completed" || status === "failed" || status === "timed_out" || status === "killed") {
      return status;
    }

    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 50);
    });
  }

  return processService.getStatus(handleId).status;
}

describe("run_cmd control tools", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-run-cmd-control-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    vi.spyOn(loggerService, "info").mockImplementation(() => {});
    vi.spyOn(loggerService, "warn").mockImplementation(() => {});
    vi.spyOn(loggerService, "error").mockImplementation(() => {});
    vi.spyOn(loggerService, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env.HOME = originalHome;

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("get_cmd_status returns running status for a background command", async () => {
    const runResult: IRunCmdOutput = await execRunCmd({
      command: "sleep 10",
      cwd: tempDir,
      timeout: 15000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const handleId: string = runResult.handleId!;
    const statusResult: ICmdStatusToolOutput = await execGetCmdStatus(handleId);

    expect(statusResult.handleId).toBe(handleId);
    expect(statusResult.status).toBe("running");
    expect(statusResult.pid).not.toBeNull();

    await execStopCmd({ handleId, signal: "SIGKILL" });
  });

  it("get_cmd_output returns stdout and stderr for a running handle", async () => {
    const runResult: IRunCmdOutput = await execRunCmd({
      command: "bash -c 'echo out-line; echo err-line >&2; sleep 10'",
      cwd: tempDir,
      timeout: 15000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const handleId: string = runResult.handleId!;
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 150);
    });

    const outputResult: ICmdOutputToolOutput = await execGetCmdOutput({
      handleId,
      channel: "both",
      maxBytes: 65536,
    });

    expect(outputResult.stdout).toContain("out-line");
    expect(outputResult.stderr).toContain("err-line");

    await execStopCmd({ handleId, signal: "SIGKILL" });
  });

  it("stop_cmd stops a running process", async () => {
    const runResult: IRunCmdOutput = await execRunCmd({
      command: "sleep 30",
      cwd: tempDir,
      timeout: 60000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const stopResult: IStopCmdOutput = await execStopCmd({
      handleId: runResult.handleId!,
      signal: "SIGTERM",
    });

    expect(stopResult.success).toBe(true);
    expect(stopResult.error).toBeNull();
  });

  it("run_cmd_input sends stdin and command output can be retrieved", async () => {
    const fixturePath: string = path.join(__dirname, "../../fixtures/interactive/requires-input.sh");
    await fs.chmod(fixturePath, 0o755);

    const runResult: IRunCmdOutput = await execRunCmd({
      command: `bash \"${fixturePath}\"`,
      cwd: tempDir,
      timeout: 15000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const handleId: string = runResult.handleId!;

    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 150);
    });

    const inputResult: IRunCmdInputResult = await execRunCmdInput({
      handleId,
      input: "hello-from-test",
      closeStdin: true,
    });

    expect(inputResult.success).toBe(true);

    const finalStatus: string = await waitForTerminalStatusAsync(handleId, 5000);
    expect(finalStatus).toBe("completed");

    const outputResult: ICmdOutputToolOutput = await execGetCmdOutput({
      handleId,
      channel: "both",
      maxBytes: 65536,
    });

    expect(outputResult.stdout).toContain("READY_FOR_INPUT");
    expect(outputResult.stdout).toContain("GOT_INPUT:hello-from-test");

    const processService: CommandProcessService = CommandProcessService.getInstance();
    processService.removeHandle(handleId);
  });
});
