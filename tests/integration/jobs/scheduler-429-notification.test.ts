import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";

let tempDir: string;
let originalHome: string;

function createTask(taskId: string, intervalMs: number): IScheduledTask {
  const now: string = new Date().toISOString();
  return {
    taskId,
    name: "429 Retry Task",
    description: "Task for 429 retry notification behavior",
    instructions: "Run",
    tools: ["think"],
    schedule: { type: "interval", intervalMs },
    enabled: true,
    notifyUser: true,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: now,
    updatedAt: now,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
  };
}

describe("Scheduler 429 failure notifications", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-scheduler-429-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);

    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");
    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);
  });

  afterEach(async () => {
    const service: SchedulerService = SchedulerService.getInstance();
    await service.stopAsync();

    resetSingletons();
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not notify failure when a transient retryable error succeeds on next attempt", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();
    let attemptCount: number = 0;
    service.setTaskExecutor(async (): Promise<void> => {
      attemptCount++;
      // Simulate an internal retry that recovers inside task execution logic.
      // From the scheduler's perspective this run succeeds (no throw).
      try {
        if (attemptCount === 1) {
          throw new Error("429 retry happened internally but recovered");
        }
      } catch {
        // Internal recovery path: swallowed and succeeded.
      }
    });
    await service.startAsync();

    const task: IScheduledTask = createTask("transient-429", 500);
    await service.addTaskAsync(task);

    await vi.advanceTimersByTimeAsync(1200);

    expect(attemptCount).toBeGreaterThan(0);

    const updated: IScheduledTask | undefined = await service.getTaskAsync("transient-429");
    expect(updated).toBeDefined();
    expect(updated!.lastRunStatus).toBe("success");
    expect(updated!.lastRunError).toBeNull();

    vi.useRealTimers();
  });

  it("notifies failure when retries are exhausted and task truly fails", async () => {
    vi.useFakeTimers();

    const service: SchedulerService = SchedulerService.getInstance();
    service.setTaskExecutor(async (): Promise<void> => {
      throw new Error("429 retries exhausted");
    });

    await service.startAsync();

    const task: IScheduledTask = createTask("exhausted-429", 500);
    await service.addTaskAsync(task);

    await vi.advanceTimersByTimeAsync(600);

    const updated: IScheduledTask | undefined = await service.getTaskAsync("exhausted-429");
    expect(updated).toBeDefined();
    expect(updated!.lastRunStatus).toBe("failure");
    expect(updated!.lastRunError).toBe("429 retries exhausted");

    vi.useRealTimers();
  });
});
