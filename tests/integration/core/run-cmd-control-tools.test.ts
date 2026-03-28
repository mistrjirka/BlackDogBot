import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runCmdTool } from "../../../src/tools/run-cmd.tool.js";
import { runCmdInputTool } from "../../../src/tools/run-cmd-input.tool.js";
import { getCmdStatusTool } from "../../../src/tools/get-cmd-status.tool.js";
import { getCmdOutputTool } from "../../../src/tools/get-cmd-output.tool.js";
import { waitForCmdTool } from "../../../src/tools/wait-for-cmd.tool.js";
import { stopCmdTool } from "../../../src/tools/stop-cmd.tool.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { CommandProcessService } from "../../../src/services/command-process.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";

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

type IWaitForCmdOutput = {
  handleId: string;
  completed: boolean;
  status: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  waitTimedOut: boolean;
  error: string | null;
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

async function execRunCmd(args: {
  command: string;
  cwd?: string;
  timeout?: number;
  mode?: string;
  deterministicInputDetection?: boolean;
}): Promise<IRunCmdOutput> {
  return await (runCmdTool as unknown as {
    invoke: (input: typeof args) => Promise<IRunCmdOutput>;
  }).invoke(args);
}

async function execGetCmdStatus(handleId: string): Promise<ICmdStatusToolOutput> {
  return await (getCmdStatusTool as unknown as {
    invoke: (input: { handleId: string }) => Promise<ICmdStatusToolOutput>;
  }).invoke({ handleId });
}

async function execGetCmdOutput(args: {
  handleId: string;
  channel: "stdout" | "stderr" | "both";
  maxBytes: number;
}): Promise<ICmdOutputToolOutput> {
  return await (getCmdOutputTool as unknown as {
    invoke: (input: typeof args) => Promise<ICmdOutputToolOutput>;
  }).invoke(args);
}

async function execRunCmdInput(args: {
  handleId: string;
  input: string;
  closeStdin?: boolean;
}): Promise<IRunCmdInputResult> {
  return await (runCmdInputTool as unknown as {
    invoke: (input: typeof args) => Promise<IRunCmdInputResult>;
  }).invoke(args);
}

async function execWaitForCmd(args: {
  handleId: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<IWaitForCmdOutput> {
  return await (waitForCmdTool as unknown as {
    invoke: (input: typeof args) => Promise<IWaitForCmdOutput>;
  }).invoke(args);
}

async function execStopCmd(args: {
  handleId: string;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT";
}): Promise<IStopCmdOutput> {
  return await (stopCmdTool as unknown as {
    invoke: (input: typeof args) => Promise<IStopCmdOutput>;
  }).invoke(args);
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
  let originalPath: string;

  async function setupSudoPacmanEmulatorAsync(password: string): Promise<void> {
    const binDir: string = path.join(tempDir, "bin");
    const sudoPath: string = path.join(binDir, "sudo");
    const pacmanPath: string = path.join(binDir, "pacman");

    await fs.mkdir(binDir, { recursive: true });

    const sudoScript: string = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ ${1:-} != \"-S\" ]]; then",
      "  echo \"sudo emulator requires -S\" >&2",
      "  exit 1",
      "fi",
      "shift",
      "printf \"[sudo] password for %s: \" \"${USER:-user}\" >&2",
      "IFS= read -r entered || true",
      `if [[ \"\${entered}\" != \"${password}\" ]]; then`,
      "  echo \"Sorry, try again.\" >&2",
      "  exit 1",
      "fi",
      "exec \"$@\"",
      "",
    ].join("\n");

    const pacmanScript: string = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"$*\" != \"-Syu\" ]]; then",
      "  echo \"pacman emulator only supports -Syu\" >&2",
      "  exit 2",
      "fi",
      "echo \":: Synchronizing package databases...\"",
      "echo \" core is up to date\"",
      "echo \" extra is up to date\"",
      "echo \":: Starting full system upgrade...\"",
      "sleep 0.1",
      "echo \" there is nothing to do\"",
      "",
    ].join("\n");

    await fs.writeFile(sudoPath, sudoScript, "utf-8");
    await fs.writeFile(pacmanPath, pacmanScript, "utf-8");
    await fs.chmod(sudoPath, 0o755);
    await fs.chmod(pacmanPath, 0o755);

    process.env.PATH = `${binDir}:${originalPath}`;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-run-cmd-control-"));
    originalHome = process.env.HOME ?? os.homedir();
    originalPath = process.env.PATH ?? "";
    process.env.HOME = tempDir;

    resetSingletons();

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    silenceLogger(loggerService);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;

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

  it("wait_for_cmd waits for completion and returns output", async () => {
    const runResult: IRunCmdOutput = await execRunCmd({
      command: "bash -c 'sleep 0.2; echo wait-done'",
      cwd: tempDir,
      timeout: 15000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const waited: IWaitForCmdOutput = await execWaitForCmd({
      handleId: runResult.handleId!,
      timeoutMs: 5000,
      maxBytes: 65536,
    });

    expect(waited.completed).toBe(true);
    expect(waited.waitTimedOut).toBe(false);
    expect(waited.status).toBe("completed");
    expect(waited.stdout).toContain("wait-done");
  });

  it("wait_for_cmd returns wait timeout when process is still waiting", async () => {
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

    const waited: IWaitForCmdOutput = await execWaitForCmd({
      handleId: runResult.handleId!,
      timeoutMs: 3000,
      maxBytes: 65536,
    });

    expect(waited.completed).toBe(false);
    expect(waited.waitTimedOut).toBe(true);
    expect(waited.status).toBe("running");

    await execStopCmd({ handleId: runResult.handleId!, signal: "SIGKILL" });
  });

  it("wait_for_cmd returns waitTimedOut for still-running process", async () => {
    const runResult: IRunCmdOutput = await execRunCmd({
      command: "sleep 5",
      cwd: tempDir,
      timeout: 15000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const waited: IWaitForCmdOutput = await execWaitForCmd({
      handleId: runResult.handleId!,
      timeoutMs: 50,
      maxBytes: 65536,
    });

    expect(waited.completed).toBe(false);
    expect(waited.waitTimedOut).toBe(true);
    expect(waited.status).toBe("running");

    await execStopCmd({ handleId: runResult.handleId!, signal: "SIGKILL" });
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

  it("emulates sudo pacman -Syu and accepts password via run_cmd_input", async () => {
    await setupSudoPacmanEmulatorAsync("tev12345");

    const runResult: IRunCmdOutput = await execRunCmd({
      command: "sudo -S pacman -Syu",
      cwd: tempDir,
      timeout: 10000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const handleId: string = runResult.handleId!;

    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 120);
    });

    const promptOutput: ICmdOutputToolOutput = await execGetCmdOutput({
      handleId,
      channel: "both",
      maxBytes: 65536,
    });

    expect(promptOutput.stderr).toContain("[sudo] password");

    const inputResult: IRunCmdInputResult = await execRunCmdInput({
      handleId,
      input: "tev12345",
      closeStdin: true,
    });

    expect(inputResult.success).toBe(true);

    const finalStatus: string = await waitForTerminalStatusAsync(handleId, 5000);
    expect(finalStatus).toBe("completed");

    const finalOutput: ICmdOutputToolOutput = await execGetCmdOutput({
      handleId,
      channel: "both",
      maxBytes: 65536,
    });

    expect(finalOutput.stdout).toContain("Synchronizing package databases");
    expect(finalOutput.stdout).toContain("Starting full system upgrade");
    expect(finalOutput.stdout).toContain("there is nothing to do");

    const processService: CommandProcessService = CommandProcessService.getInstance();
    processService.removeHandle(handleId);
  });

  it("emulates sudo pacman -Syu and fails on wrong password", async () => {
    await setupSudoPacmanEmulatorAsync("correct-password");

    const runResult: IRunCmdOutput = await execRunCmd({
      command: "sudo -S pacman -Syu",
      cwd: tempDir,
      timeout: 10000,
      mode: "background",
      deterministicInputDetection: false,
    });

    expect(runResult.status).toBe("running");
    expect(runResult.handleId).toBeTruthy();

    const handleId: string = runResult.handleId!;

    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 120);
    });

    const inputResult: IRunCmdInputResult = await execRunCmdInput({
      handleId,
      input: "wrong-password",
      closeStdin: true,
    });

    expect(inputResult.success).toBe(true);

    const finalStatus: string = await waitForTerminalStatusAsync(handleId, 5000);
    expect(finalStatus).toBe("failed");

    const finalOutput: ICmdOutputToolOutput = await execGetCmdOutput({
      handleId,
      channel: "both",
      maxBytes: 65536,
    });

    expect(finalOutput.stderr).toContain("Sorry, try again");

    const processService: CommandProcessService = CommandProcessService.getInstance();
    processService.removeHandle(handleId);
  });
});
