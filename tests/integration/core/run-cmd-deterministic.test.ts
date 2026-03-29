import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runCmdTool } from "../../../src/tools/run-cmd.tool.js";
import { runCmdInputTool } from "../../../src/tools/run-cmd-input.tool.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { CommandProcessService } from "../../../src/services/command-process.service.js";
import { CommandDetectorLinuxService } from "../../../src/services/command-detector-linux.service.js";
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

async function execRunCmd(args: {
  command: string;
  cwd?: string;
  timeout?: number;
  mode?: string;
  deterministicInputDetection?: boolean;
}): Promise<IRunCmdOutput> {
  return await (runCmdTool as unknown as { invoke: (input: typeof args) => Promise<IRunCmdOutput> }).invoke(args);
}

async function execRunCmdInput(args: {
  handleId: string;
  input: string;
  closeStdin?: boolean;
}): Promise<{ success: boolean; status: string; stdout: string; stderr: string; exitCode: number | null; error: string | null }> {
  return await (runCmdInputTool as unknown as {
    invoke: (
      input: { handleId: string; input: string; closeStdin?: boolean },
    ) => Promise<{ success: boolean; status: string; stdout: string; stderr: string; exitCode: number | null; error: string | null }>;
  }).invoke(args);
}

describe("run_cmd tool", () => {
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
      "if [[ ${1:-} == \"-A\" ]]; then",
      "  shift",
      "  if [[ -z ${SUDO_ASKPASS:-} ]]; then",
      "    echo \"SUDO_ASKPASS is required for -A\" >&2",
      "    exit 1",
      "  fi",
      "  entered=\"$(${SUDO_ASKPASS})\"",
      `  if [[ \"\${entered}\" != \"${password}\" ]]; then`,
      "    echo \"Sorry, try again.\" >&2",
      "    exit 1",
      "  fi",
      "  exec \"$@\"",
      "fi",
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

  async function setupRealisticSudoPacmanEmulatorAsync(password: string): Promise<void> {
    const binDir: string = path.join(tempDir, "bin");
    const sudoPath: string = path.join(binDir, "sudo");
    const pacmanPath: string = path.join(binDir, "pacman");

    await fs.mkdir(binDir, { recursive: true });

    const sudoScript: string = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ ${1:-} == \"-A\" ]]; then",
      "  shift",
      "  if [[ -z ${SUDO_ASKPASS:-} ]]; then",
      "    echo \"sudo: no askpass program specified\" >&2",
      "    exit 1",
      "  fi",
      "  entered=\"$(${SUDO_ASKPASS})\"",
      `  if [[ \"\${entered}\" != \"${password}\" ]]; then`,
      "    echo \"Sorry, try again.\" >&2",
      "    exit 1",
      "  fi",
      "  exec \"$@\"",
      "fi",
      "if [[ ${1:-} == \"-S\" ]]; then",
      "  shift",
      "  printf \"[sudo] password for %s: \" \"${USER:-user}\" >&2",
      "  IFS= read -r entered || true",
      `  if [[ \"\${entered}\" != \"${password}\" ]]; then`,
      "    echo \"Sorry, try again.\" >&2",
      "    exit 1",
      "  fi",
      "  exec \"$@\"",
      "fi",
      "",
      "# Emulate real sudo without -S: prompt appears but stdin piping won't satisfy it.",
      "printf \"[sudo] password for %s: \" \"${USER:-user}\" >&2",
      "sleep 999",
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
      "echo \":: Starting full system upgrade...\"",
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-run-cmd-"));
    originalHome = process.env.HOME ?? os.homedir();
    originalPath = process.env.PATH ?? "";
    process.env.HOME = tempDir;

    resetSingletons();

    const loggerService = LoggerService.getInstance();
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

  describe("simple command completes", () => {
    it("should complete echo hello with exit code 0", async () => {
      const result = await execRunCmd({
        command: "echo hello",
        cwd: tempDir,
        timeout: 5000,
        mode: "foreground",
        deterministicInputDetection: false,
      });

      expect(result.status).toBe("completed");
      expect(result.stdout).toContain("hello");
      expect(result.exitCode).toBe(0);
      expect(result.handleId).toBeNull();
      expect(result.timedOut).toBe(false);
    });
  });

  describe("command with stderr", () => {
    it("should capture stderr separately from stdout", async () => {
      const result = await execRunCmd({
        command: "echo err >&2; echo ok",
        cwd: tempDir,
        timeout: 5000,
        mode: "foreground",
        deterministicInputDetection: false,
      });

      expect(result.status).toBe("completed");
      expect(result.stderr).toContain("err");
      expect(result.stdout).toContain("ok");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("background mode", () => {
    it("should return running status with handleId for background command", async () => {
      const result = await execRunCmd({
        command: "sleep 5",
        cwd: tempDir,
        timeout: 10000,
        mode: "background",
        deterministicInputDetection: false,
      });

      expect(result.status).toBe("running");
      expect(result.handleId).not.toBeNull();
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      if (result.handleId) {
        const processService = CommandProcessService.getInstance();
        await processService.stopAsync(result.handleId);
        processService.removeHandle(result.handleId);
      }
    });
  });

  describe("timeout", () => {
    it("should return timed_out status when command exceeds timeout", async () => {
      const result = await execRunCmd({
        command: "sleep 30",
        cwd: tempDir,
        timeout: 500,
        mode: "foreground",
        deterministicInputDetection: false,
      });

      expect(result.status).toBe("timed_out");
      expect(result.timedOut).toBe(true);
      expect(result.handleId).toBeNull();
    });
  });

  describe("deterministic stdin detection", () => {
    it("should fall back to normal execution when detector is unavailable", async () => {
      if (process.platform === "linux") {
        // On Linux, detector may or may not be available (depends on strace/ptrace).
        // If unavailable, run_cmd should continue without deterministic detection.
        const result = await execRunCmd({
          command: "sleep 30",
          cwd: tempDir,
          timeout: 3000,
          mode: "foreground",
          deterministicInputDetection: true,
        });

        // Regardless of detector availability, command should run and timeout.
        expect(result.status).toBe("timed_out");
      } else {
        // Non-Linux: deterministic detector still unsupported and should fail early.
        const result = await execRunCmd({
          command: "echo hello",
          cwd: tempDir,
          timeout: 5000,
          mode: "foreground",
          deterministicInputDetection: true,
        });

        expect(result.status).toBe("failed");
        expect(result.error).toContain("Linux");
        expect(result.deterministic).toBe(false);
      }
    });

    it("should complete non-interactive command without false awaiting_input", async () => {
      const result = await execRunCmd({
        command: "echo test",
        cwd: tempDir,
        timeout: 5000,
        mode: "foreground",
        deterministicInputDetection: false,
      });

      expect(result.status).toBe("completed");
      expect(result.stdout).toContain("test");
      expect(result.handleId).toBeNull();
    });

    it("should run interactive fixture end-to-end via run_cmd tool", async () => {
      if (process.platform !== "linux") {
        console.log("Skipping: deterministic stdin detection only available on Linux");
        return;
      }

      const fixturePath = path.join(__dirname, "../../fixtures/interactive/requires-input.sh");

      // Make script executable
      await fs.chmod(fixturePath, 0o755);

      const runResult = await execRunCmd({
        command: `bash "${fixturePath}"`,
        cwd: tempDir,
        timeout: 10000,
        mode: "foreground",
        deterministicInputDetection: true,
      });

      // If detector unavailable, command runs without deterministic mode and exits normally.
      // If detector available, command stops at awaiting_input and can be resumed via run_cmd_input.
      if (runResult.status === "timed_out") {
        expect(runResult.deterministic).toBe(false);
        expect(runResult.stdout).toContain("READY_FOR_INPUT");
        return;
      }

      expect(runResult.status).toBe("awaiting_input");
      expect(runResult.handleId).not.toBeNull();
      expect(runResult.stdout).toContain("READY_FOR_INPUT");

      const handleId: string = runResult.handleId!;
      const inputResult = await execRunCmdInput({
        handleId,
        input: "test_value",
        closeStdin: true,
      });

      expect(inputResult.success).toBe(true);

      // Wait for command to finish, then verify output via process service
      const processService = CommandProcessService.getInstance();
      await new Promise<void>((resolve): void => {
        const interval = setInterval((): void => {
          const status = processService.getStatus(handleId).status;
          if (status === "completed" || status === "failed" || status === "timed_out" || status === "killed") {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      const finalStatus = processService.getStatus(handleId).status;
      const finalStdout = processService.getOutput(handleId, "stdout", 65536).data;

      expect(finalStatus).toBe("completed");
      expect(finalStdout).toContain("READY_FOR_INPUT");
      expect(finalStdout).toContain("GOT_INPUT:test_value");

      processService.removeHandle(handleId);
    });

    it("should return awaiting_input for sudo prompt when detector is unavailable", async () => {
      if (process.platform !== "linux") {
        console.log("Skipping: deterministic stdin detection behavior is Linux-only");
        return;
      }

      await setupSudoPacmanEmulatorAsync("tev12345");

      const detector: CommandDetectorLinuxService = CommandDetectorLinuxService.getInstance();
      const detectorSpy = vi.spyOn(detector, "startAsync").mockResolvedValue({
        handleId: "",
        available: false,
        error: "mock detector unavailable",
      });

      const runResult = await execRunCmd({
        command: "sudo -S pacman -Syu",
        cwd: tempDir,
        timeout: 3000,
        mode: "foreground",
        deterministicInputDetection: true,
      });

      detectorSpy.mockRestore();

      expect(runResult.status).toBe("awaiting_input");
      expect(runResult.handleId).not.toBeNull();

      const handleId: string = runResult.handleId!;
      const inputResult = await execRunCmdInput({
        handleId,
        input: "tev12345",
        closeStdin: true,
      });

      expect(inputResult.success).toBe(true);

      const processService = CommandProcessService.getInstance();
      await new Promise<void>((resolve): void => {
        const interval = setInterval((): void => {
          const status = processService.getStatus(handleId).status;
          if (status === "completed" || status === "failed" || status === "timed_out" || status === "killed") {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      const finalStatus = processService.getStatus(handleId).status;
      const finalStdout = processService.getOutput(handleId, "stdout", 65536).data;

      expect(finalStatus).toBe("completed");
      expect(finalStdout).toContain("Synchronizing package databases");

      processService.removeHandle(handleId);
    });

    it("should normalize sudo without -S and complete via run_cmd_input", async () => {
      if (process.platform !== "linux") {
        console.log("Skipping: deterministic stdin detection behavior is Linux-only");
        return;
      }

      await setupRealisticSudoPacmanEmulatorAsync("tev12345");

      const detector: CommandDetectorLinuxService = CommandDetectorLinuxService.getInstance();
      const detectorSpy = vi.spyOn(detector, "startAsync").mockResolvedValue({
        handleId: "",
        available: false,
        error: "mock detector unavailable",
      });

      const startedAt: number = Date.now();
      const runResult = await execRunCmd({
        command: "sudo pacman -Syu",
        cwd: tempDir,
        timeout: 10000,
        mode: "foreground",
        deterministicInputDetection: true,
      });
      const elapsedMs: number = Date.now() - startedAt;

      detectorSpy.mockRestore();

      expect(runResult.status).toBe("awaiting_input");
      expect(runResult.handleId).not.toBeNull();
      expect(elapsedMs).toBeLessThan(5000);

      const handleId: string = runResult.handleId!;
      const inputResult = await execRunCmdInput({
        handleId,
        input: "tev12345",
        closeStdin: true,
      });

      expect(inputResult.success).toBe(true);

      const processService = CommandProcessService.getInstance();

      await new Promise<void>((resolve): void => {
        const interval = setInterval((): void => {
          const status = processService.getStatus(handleId).status;
          if (status === "completed" || status === "failed" || status === "timed_out" || status === "killed") {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      const finalStatus = processService.getStatus(handleId).status;
      const finalStdout = processService.getOutput(handleId, "stdout", 65536).data;

      expect(finalStatus).toBe("completed");
      expect(finalStdout).toContain("Synchronizing package databases");

      processService.removeHandle(handleId);
    });
  });
});
