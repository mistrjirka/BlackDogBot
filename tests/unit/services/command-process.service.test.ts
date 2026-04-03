import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandProcessService } from "../../../src/services/command-process.service.js";

describe("CommandProcessService", () => {
  let service: CommandProcessService;

  beforeEach(() => {
    service = CommandProcessService.getInstance();
  });

  afterEach(() => {
    const handles = Array.from((service as any)._processes.keys()) as string[];
    for (const handleId of handles) {
      service.removeHandle(handleId);
    }
  });

  it("spawnProcessAsync creates entry with status=running", async () => {
    const result = await service.spawnProcessAsync("echo hello", "/tmp", 5000);

    expect(result.handleId).toBeTruthy();
    expect(result.status).toBe("running");

    await new Promise<void>((resolve): void => {
      result.child.on("exit", () => resolve());
    });

    const status = service.getStatus(result.handleId);
    expect(status.status).toBe("completed");
  });

  it("getStatus returns correct info for existing handle", async () => {
    const result = await service.spawnProcessAsync("echo test", "/tmp", 5000);

    await new Promise<void>((resolve): void => {
      result.child.on("exit", () => resolve());
    });

    const status = service.getStatus(result.handleId);

    expect(status.status).toBe("completed");
    expect(status.exitCode).toBe(0);
    expect(status.startedAt).toBeTruthy();
  });

  it("getStatus returns error for unknown handleId", () => {
    const status = service.getStatus("nonexistent-handle");

    expect(status.status).toBe("completed");
    expect(status.error).toContain("not found");
  });

  it("getOutput returns collected stdout", async () => {
    const result = await service.spawnProcessAsync("echo hello world", "/tmp", 5000);

    await new Promise<void>((resolve): void => {
      result.child.on("exit", () => resolve());
    });

    const output = service.getOutput(result.handleId, "stdout", 1024);

    expect(output.data).toContain("hello world");
    expect(output.truncated).toBe(false);
  });

  it("stopAsync kills running process", async () => {
    const result = await service.spawnProcessAsync("sleep 60", "/tmp", 5000);

    expect(result.status).toBe("running");

    const stopResult = await service.stopAsync(result.handleId, "SIGKILL");

    expect(stopResult.success).toBe(true);

    const status = service.getStatus(result.handleId);
    expect(status.status).toBe("killed");
  });

  it("onStdinBlocked sets status to awaiting_input", async () => {
    const result = await service.spawnProcessAsync("cat", "/tmp", 5000);

    expect(result.status).toBe("running");

    service.onStdinBlocked(result.handleId);

    const status = service.getStatus(result.handleId);
    expect(status.status).toBe("awaiting_input");
  });

  it("removeHandle cleans up", async () => {
    const result = await service.spawnProcessAsync("echo hello", "/tmp", 5000);

    await new Promise<void>((resolve): void => {
      result.child.on("exit", () => resolve());
    });

    const handlesBefore = (service as any)._processes.size;

    service.removeHandle(result.handleId);

    const handlesAfter = (service as any)._processes.size;
    expect(handlesAfter).toBe(handlesBefore - 1);
  });

  it("spawnProcessAsync throws with clear error for non-existent cwd", async () => {
    await expect(
      service.spawnProcessAsync("echo test", "/nonexistent/path/that/does/not/exist", 5000),
    ).rejects.toThrow(/working directory does not exist/i);
  });

  it("spawnProcessAsync throws with clear error for invalid cwd like tilde-in-path", async () => {
    await expect(
      service.spawnProcessAsync("echo test", "/~/.blackdogbot", 5000),
    ).rejects.toThrow(/working directory does not exist/i);
  });
});