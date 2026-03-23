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
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { editCronInstructionsTool } from "../../../src/tools/edit-cron-instructions.tool.js";
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
    tools: ["fetch_rss", "write_table_news_items", "send_message"],
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
  instructions?: string;
  intention?: string;
  tools?: string[];
}, messages: any[] = []): Promise<any> {
  return await (editCronInstructionsTool as any).execute(
    args,
    { toolCallId: "test-edit", messages, abortSignal: new AbortController().signal },
  );
}

describe("editCronInstructionsTool instruction verification", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-editcron-verif-"));
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

  it("should reject when instructions change but intention is missing", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml and store in database.",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("intention");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should reject when instructions are unchanged", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/feed.xml and store in database.",
      intention: "No-op check",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No instruction change detected");

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
      intention: "Simplify wording while keeping behavior",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("EDIT REJECTED");
    expect(result.error).toContain(task.instructions);
    expect(result.error).toContain("Fetch that feed we talked about");
    expect(result.error).toContain("Intention: Simplify wording while keeping behavior");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should approve when instructions change with valid intention and verifier approves", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml and store in database. Only unseen items.",
      intention: "Switch to new feed URL and unseen mode for dedup",
    }, messages);

    expect(result.success).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task.instructions).toContain("new-feed.xml");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toContain("new-feed.xml");
  });

  it("should reject instruction edits with only whitespace difference", async () => {
    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/feed.xml and store in database.  ",
      intention: "Whitespace-only",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No instruction change detected");
  });

  it("should reject run_cmd+sqlite instructions with explicit guidance", async () => {
    const task = await createTaskDirectly({
      tools: ["fetch_rss", "read_from_database", "write_table_articles", "send_message"],
    });
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Use run_cmd with sqlite3 insert into articles for every fetched item.",
      intention: "Store rows quickly",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not use run_cmd with sqlite/sqlite3");
    expect(result.error).toContain("write_table_articles");
  });

  it("should allow updating instructions and tools in one call", async () => {
    const task = await createTaskDirectly({
      tools: ["fetch_rss", "read_from_database", "write_table_articles", "send_message"],
    });
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Use fetch_rss in unseen mode, store all items via write_table_articles, and verify key military claims with searxng.",
      intention: "Need web verification before alerting",
      tools: ["fetch_rss", "read_from_database", "write_table_articles", "searxng", "send_message"],
    }, messages);

    expect(result.success).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task.instructions).toContain("searxng");
    expect(result.task.tools).toContain("searxng");
  });
});
