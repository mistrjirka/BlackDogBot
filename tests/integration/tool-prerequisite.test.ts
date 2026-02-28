import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { SchedulerService } from "../../src/services/scheduler.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import { getCronTool } from "../../src/tools/get-cron.tool.js";
import { editCronTool } from "../../src/tools/edit-cron.tool.js";
import type { IScheduledTask } from "../../src/shared/types/index.js";

let tempDir: string;
let originalHome: string;
let schedulerService: SchedulerService;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (SchedulerService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
}

async function createTaskDirectly(name: string): Promise<string> {
  const task: IScheduledTask = {
    taskId: `test-task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name,
    description: "Test task",
    instructions: "Do something",
    tools: ["think"],
    schedule: { type: "once", runAt: new Date(Date.now() + 60000).toISOString() },
    enabled: true,
    notifyUser: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
  };
  await schedulerService.addTaskAsync(task);
  return task.taskId;
}

async function execGetCronTool(args: { taskId: string }, messages: any[] = []): Promise<any> {
  return await (getCronTool as any).execute(
    args,
    { toolCallId: "test-get", messages, abortSignal: new AbortController().signal },
  );
}

async function execEditCronTool(args: {
  taskId: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: string[];
  schedule?: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
  notifyUser?: boolean;
  enabled?: boolean;
}, messages: any[] = []): Promise<any> {
  return await (editCronTool as any).execute(
    args,
    { toolCallId: "test-edit", messages, abortSignal: new AbortController().signal },
  );
}

describe("editCronTool prerequisites", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-prereq-test-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);

    const promptService: PromptService = PromptService.getInstance();
    await promptService.initializeAsync();

    schedulerService = SchedulerService.getInstance();
    await schedulerService.startAsync();
  });

  afterEach(async () => {
    try {
      await schedulerService.stopAsync();
    } catch {
      // ignore
    }
    resetSingletons();
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should reject edit_cron if get_cron was never called", async () => {
    const taskId = await createTaskDirectly("Test Task");

    const editResult = await execEditCronTool({
      taskId,
      name: "Updated Name",
    }, []);

    expect(editResult.success).toBe(false);
    expect(editResult.error).toContain("MISSING PREREQUISITE");
    expect(editResult.error).toContain("get_cron");
  });

  it("should reject edit_cron if get_cron was called with different taskId", async () => {
    const task1Id = await createTaskDirectly("Task 1");
    const task2Id = await createTaskDirectly("Task 2");

    const messagesWithGetCron = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "get_cron",
            input: { taskId: task1Id },
            toolCallId: "call_123",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_123",
        content: JSON.stringify({ success: true, task: {} }),
      },
    ];

    const editResult = await execEditCronTool({
      taskId: task2Id,
      name: "Updated Name",
    }, messagesWithGetCron as any);

    expect(editResult.success).toBe(false);
    expect(editResult.error).toContain("MISSING PREREQUISITE");
    expect(editResult.error).toContain(task2Id);
  });

  it("should allow edit_cron if get_cron was called with same taskId", async () => {
    const taskId = await createTaskDirectly("Test Task");

    const messagesWithGetCron = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "get_cron",
            input: { taskId },
            toolCallId: "call_123",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_123",
        content: JSON.stringify({ success: true, task: {} }),
      },
    ];

    const editResult = await execEditCronTool({
      taskId,
      name: "Updated Name",
    }, messagesWithGetCron as any);

    expect(editResult.success).toBe(true);
    expect(editResult.task).toBeDefined();
    expect(editResult.task?.name).toBe("Updated Name");
  });

  it("should allow edit_cron even if other tools were called in between get_cron and edit_cron", async () => {
    const taskId = await createTaskDirectly("Test Task");

    const messagesWithInterveningTools = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "get_cron",
            input: { taskId },
            toolCallId: "call_123",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_123",
        content: JSON.stringify({ success: true, task: {} }),
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "list_crons",
            input: {},
            toolCallId: "call_456",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_456",
        content: JSON.stringify({ tasks: [] }),
      },
      {
        role: "user",
        content: "Now edit the task",
      },
    ];

    const editResult = await execEditCronTool({
      taskId,
      enabled: false,
    }, messagesWithInterveningTools as any);

    expect(editResult.success).toBe(true);
    expect(editResult.task).toBeDefined();
    expect(editResult.task?.enabled).toBe(false);
  });

  it("get_cron should work without prerequisites", async () => {
    const taskId = await createTaskDirectly("Test Task");

    const getResult = await execGetCronTool({ taskId }, []);

    expect(getResult.success).toBe(true);
    expect(getResult.task).toBeDefined();
    expect(getResult.task?.name).toBe("Test Task");
  });
});
