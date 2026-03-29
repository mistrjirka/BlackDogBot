import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { createTestEnvironment, loadTestConfigAsync, resetSingletons } from "../../utils/test-helpers.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

const env = createTestEnvironment("scheduler-stop-concurrency");

function createIntervalTask(taskId: string, intervalMs: number): IScheduledTask {
  const nowIso: string = new Date().toISOString();
  return {
    taskId,
    name: taskId,
    description: "test task",
    instructions: "test instructions",
    tools: ["think"],
    schedule: {
      type: "interval",
      intervalMs,
    },
    enabled: true,
    notifyUser: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
  };
}

describe("SchedulerService stop concurrency handling", () => {
  beforeEach(async () => {
    await env.setupAsync({ logLevel: "error" });
    await loadTestConfigAsync(env.tempDir, {
      scheduler: {
        enabled: true,
        maxParallelCrons: 1,
        cronQueueSize: 1,
      },
      originalHome: env.originalHome,
    });
    const configService = ConfigService.getInstance();
    await configService.initializeAsync();
  });

  afterEach(async () => {
    resetSingletons();
    await env.teardownAsync();
  });

  it("should not decrement runningTaskCount below zero when stopped during execution", async () => {
    const scheduler = SchedulerService.getInstance();
    const logger = LoggerService.getInstance();
    await logger.initializeAsync("error", path.join(env.tempDir, "logs"));

    let releaseExecution: () => void = () => {
      throw new Error("releaseExecution was not set");
    };
    const started = new Promise<void>((resolve) => {
      scheduler.setTaskExecutor(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseExecution = release;
        });
      });
    });

    const task = createIntervalTask("stop-mid-flight", 20);
    await scheduler.addTaskAsync(task);
    await scheduler.startAsync();

    await started;
    const stopPromise = scheduler.stopAsync();
    releaseExecution();
    await stopPromise;

    expect(scheduler.getRunningTaskCount()).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(scheduler.getRunningTaskCount()).toBe(0);

    const cronDir = path.join(env.tempDir, ".blackdogbot", "cron");
    const entries = await fs.readdir(cronDir);
    expect(entries.includes("stop-mid-flight.json")).toBe(true);
  });

  it("should wait for in-flight task execution to finish before stopAsync resolves", async () => {
    const scheduler = SchedulerService.getInstance();
    const logger = LoggerService.getInstance();
    await logger.initializeAsync("error", path.join(env.tempDir, "logs"));

    let releaseExecution: () => void = () => {
      throw new Error("releaseExecution was not set");
    };
    let stopResolved = false;

    const started = new Promise<void>((resolve) => {
      scheduler.setTaskExecutor(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseExecution = release;
        });
      });
    });

    const task = createIntervalTask("stop-awaits-inflight", 20);
    await scheduler.addTaskAsync(task);
    await scheduler.startAsync();
    await started;

    const stopPromise = scheduler.stopAsync().then(() => {
      stopResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopResolved).toBe(false);

    releaseExecution();
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(scheduler.getRunningTaskCount()).toBe(0);
  });
});
