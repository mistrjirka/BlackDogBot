import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("../../../src/utils/llm-retry.js", () => ({
  generateObjectWithRetryAsync: vi.fn(async () => ({
    object: {
      isClear: true,
      missingContext: "",
    },
  })),
}));

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { editCronTool } from "../../../src/tools/edit-cron.tool.js";
import { generateObjectWithRetryAsync } from "../../../src/utils/llm-retry.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

let tempDir: string;
let originalHome: string;
let schedulerService: SchedulerService;

async function createTaskDirectly(overrides?: Partial<IScheduledTask>): Promise<IScheduledTask> {
  const task: IScheduledTask = {
    taskId: `test-task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: "Test Task",
    description: "Test task",
    instructions: "Fetch RSS from http://example.com/feed.xml and store in database.",
    tools: ["fetch_rss", "write_to_database", "send_message"],
    schedule: { type: "cron", expression: "0 */2 * * *" },
    enabled: true,
    notifyUser: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    ...overrides,
  };
  await schedulerService.addTaskAsync(task);
  return task;
}

function createGetCronMessages(taskId: string): any[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolName: "get_cron",
          input: { taskId },
          toolCallId: "call_prereq",
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_prereq",
      content: JSON.stringify({ success: true, task: {} }),
    },
  ];
}

async function execEditCronTool(args: {
  taskId: string;
  name?: string;
  description?: string;
  instructions?: string;
  instructionChangeWhat?: string;
  instructionChangeWhy?: string;
  tools?: string[];
  scheduleType?: "once" | "interval" | "cron";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleCron?: string;
  notifyUser?: boolean;
  enabled?: boolean;
}, messages: any[] = []): Promise<any> {
  return await (editCronTool as any).execute(
    args,
    { toolCallId: "test-edit", messages, abortSignal: new AbortController().signal },
  );
}

describe("editCronTool instruction verification", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-editcron-verif-"));
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

    vi.mocked(generateObjectWithRetryAsync).mockReset();
    vi.mocked(generateObjectWithRetryAsync).mockResolvedValue({
      object: {
        isClear: true,
        missingContext: "",
      },
    } as any);
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

  it("should reject when instructions change but instructionChangeWhat is missing", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml and store in database.",
      instructionChangeWhy: "Feed URL changed",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("instructionChangeWhat");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should reject when instructions change but instructionChangeWhy is missing", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml and store in database.",
      instructionChangeWhat: "Changed feed URL",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("instructionChangeWhy");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should reject when instructions change and both metadata fields are missing", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml and store in database.",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("instructionChangeWhat");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should reject when instructions change and verifier rejects", async () => {
    vi.mocked(generateObjectWithRetryAsync).mockResolvedValueOnce({
      object: {
        isClear: false,
        missingContext: "The new instructions reference a conversation-specific URL that was never specified.",
      },
    } as any);

    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch that feed we talked about",
      instructionChangeWhat: "Shortened instructions",
      instructionChangeWhy: "Make it simpler",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("EDIT REJECTED");
    expect(result.error).toContain(task.instructions);
    expect(result.error).toContain("Fetch that feed we talked about");
    expect(result.error).toContain("Shortened instructions");
    expect(result.error).toContain("Make it simpler");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should approve when instructions change with valid metadata and verifier approves", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml and store in database. Only unseen items.",
      instructionChangeWhat: "Updated feed URL and added unseen-only mode",
      instructionChangeWhy: "Old feed URL is deprecated, switched to new provider",
    }, messages);

    expect(result.success).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task.instructions).toContain("new-feed.xml");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toContain("new-feed.xml");
  });

  it("should allow non-instruction edits without change metadata", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      name: "Updated Name",
      description: "Updated description",
      enabled: false,
    }, messages);

    expect(result.success).toBe(true);
    expect(result.task?.name).toBe("Updated Name");
    expect(result.task?.enabled).toBe(false);
  });

  it("should allow instruction edits with only whitespace difference without metadata", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/feed.xml and store in database.  ",
    }, messages);

    expect(result.success).toBe(true);
    expect(result.task?.instructions).toContain("example.com/feed.xml");
  });
});
