import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { editCronTool } from "../../../src/tools/edit-cron.tool.js";
import type { IScheduledTask } from "../../../src/shared/types/index.js";

const localBaseUrl: string = "http://localhost:2345";

let tempDir: string;
let originalHome: string;
let schedulerService: SchedulerService;
let endpointReachable: boolean = false;

async function isEndpointReachableAsync(): Promise<boolean> {
  const abortController: AbortController = new AbortController();
  const timeoutId: NodeJS.Timeout = setTimeout(() => abortController.abort(), 3000);

  try {
    const response: Response = await fetch(`${localBaseUrl}/v1/models`, {
      method: "GET",
      signal: abortController.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-editcron-e2e-"));
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
  await aiProviderService.initializeAsync(configService.getConfig().ai);

  const promptService: PromptService = PromptService.getInstance();
  await promptService.initializeAsync();

  schedulerService = SchedulerService.getInstance();
  await schedulerService.startAsync();

  endpointReachable = await isEndpointReachableAsync();
});

afterAll(async () => {
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

async function createTaskDirectly(overrides?: Partial<IScheduledTask>): Promise<IScheduledTask> {
  const task: IScheduledTask = {
    taskId: `e2e-task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: "E2E Test Task",
    description: "E2E instruction verification test",
    instructions: "Fetch RSS from http://example.com/feed.xml and store results in database.",
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
  instructions?: string;
  instructionChangeWhat?: string;
  instructionChangeWhy?: string;
  tools?: string[];
  name?: string;
  description?: string;
  enabled?: boolean;
  notifyUser?: boolean;
}, messages: any[] = []): Promise<any> {
  return await (editCronTool as any).execute(
    args,
    { toolCallId: "e2e-edit", messages, abortSignal: new AbortController().signal },
  );
}

describe("editCronTool instruction verification E2E", () => {
  it("should reject ambiguous new instructions and keep task unchanged", async () => {
    if (!endpointReachable) {
      console.log("Skipping: local endpoint not reachable");
      return;
    }

    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Do what we discussed",
      instructionChangeWhat: "Simplified instructions",
      instructionChangeWhy: "Shorter is better",
    }, messages);

    expect(result.success).toBe(false);
    expect(result.error).toContain("EDIT REJECTED");
    expect(result.error).toContain(task.instructions);
    expect(result.error).toContain("Do what we discussed");
    expect(result.error).toContain("Simplified instructions");

    const persisted = await schedulerService.getTaskAsync(task.taskId);
    expect(persisted?.instructions).toBe(task.instructions);
  });

  it("should approve a valid instruction change with full context", async () => {
    if (!endpointReachable) {
      console.log("Skipping: local endpoint not reachable");
      return;
    }

    const task = await createTaskDirectly();
    const messages = createGetCronMessages(task.taskId);

    const result = await execEditCronTool({
      taskId: task.taskId,
      instructions: "Fetch RSS from http://example.com/new-feed.xml. Mode=unseen. Write results to database 'news' table 'items'. Only write is_interesting=true entries.",
      instructionChangeWhat: "Updated feed URL, added unseen mode filter, set is_interesting=true requirement",
      instructionChangeWhy: "Switched to new feed provider, need tighter quality filtering",
    }, messages);

    expect(result.success).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task.instructions).toContain("new-feed.xml");
  });
});
