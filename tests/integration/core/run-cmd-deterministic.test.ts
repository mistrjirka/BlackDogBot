import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runCmdTool } from "../../../src/tools/run-cmd.tool.js";
import { runCmdInputTool } from "../../../src/tools/run-cmd-input.tool.js";
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

const TOOL_OPTIONS = { toolCallId: "tc1", messages: [] as never[], abortSignal: new AbortController().signal };

async function execRunCmd(args: {
  command: string;
  cwd?: string;
  timeout?: number;
  mode?: string;
  deterministicInputDetection?: boolean;
}): Promise<IRunCmdOutput> {
  return await (runCmdTool as unknown as { execute: (input: typeof args, options: typeof TOOL_OPTIONS) => Promise<IRunCmdOutput> }).execute(args, TOOL_OPTIONS);
}

async function execRunCmdInput(args: {
  handleId: string;
  input: string;
  closeStdin?: boolean;
}): Promise<{ success: boolean; status: string; stdout: string; stderr: string; exitCode: number | null; error: string | null }> {
  return await (runCmdInputTool as unknown as {
    execute: (
      input: { handleId: string; input: string; closeStdin?: boolean },
      options: typeof TOOL_OPTIONS,
    ) => Promise<{ success: boolean; status: string; stdout: string; stderr: string; exitCode: number | null; error: string | null }>;
  }).execute(args, TOOL_OPTIONS);
}

describe("run_cmd tool", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-run-cmd-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    silenceLogger(loggerService);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;

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

  describe("deterministic stdin detection - strict mode", () => {
    it("should fail immediately when detector is unavailable (no fallback)", async () => {
      if (process.platform === "linux") {
        // On Linux, detector may or may not be available (depends on strace/ptrace).
        // We test the strict contract: if unavailable, must fail.
        const result = await execRunCmd({
          command: "sleep 30",
          cwd: tempDir,
          timeout: 3000,
          mode: "foreground",
          deterministicInputDetection: true,
        });

        // If detector IS available, this will timeout (30s command with 3s timeout).
        // If detector is NOT available, it should fail with strict error.
        // Both are valid — we just verify it never silently pretends to be deterministic.
        if (result.status === "failed") {
          expect(result.error).toContain("Deterministic stdin detection unavailable");
          expect(result.deterministic).toBe(false);
        } else if (result.status === "timed_out") {
          expect(result.deterministic).toBe(true);
        }
      } else {
        // Non-Linux: must fail immediately
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

      // Strict mode contract on Linux:
      // - If detector unavailable => hard failure (no fallback)
      // - If detector available => awaiting_input with handleId
      if (runResult.status === "failed") {
        expect(runResult.error).toContain("Deterministic stdin detection unavailable");
        expect(runResult.deterministic).toBe(false);
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
  });
});
