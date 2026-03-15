import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { CronAgent } from "../../../src/agent/cron-agent.js";
import type { IScheduledTask, IExecutionContext } from "../../../src/shared/types/index.js";
import type { MessageSender } from "../../../src/tools/index.js";

let tempDir: string;
let originalHome: string;


function createTask(overrides?: Partial<IScheduledTask>): IScheduledTask {
  const now: string = new Date().toISOString();

  return {
    taskId: "test-task-001",
    name: "Test Task",
    description: "A test scheduled task",
    instructions: "Do something",
    tools: ["think"],
    schedule: { type: "interval", intervalMs: 60000 },
    enabled: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: now,
    updatedAt: now,
    notifyUser: false,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    ...overrides,
  };
}

function createExecutionContext(): IExecutionContext {
  return { toolCallHistory: [] };
}

describe("CronAgent tool resolution", () => {
  let logger: LoggerService;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-cron-tool-res-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    logger = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
    warnSpy = vi.spyOn(LoggerService.prototype, "warn").mockReturnValue(undefined);

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

    const schedulerService: SchedulerService = SchedulerService.getInstance();
    await schedulerService.startAsync();
  });

  afterEach(async () => {
    try {
      const service: SchedulerService = SchedulerService.getInstance();
      await service.stopAsync();
    } catch {
      // ignore
    }
    resetSingletons();
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should resolve valid tool names into a working tool set", async () => {
    const task: IScheduledTask = createTask({
      tools: ["think", "fetch_rss", "searxng"],
    });

    const mockSender: MessageSender = async (): Promise<string | null> => {
      return null;
    };

    const agent: CronAgent = CronAgent.getInstance();

    const executionContext: IExecutionContext = createExecutionContext();
    const taskIdProvider = (): string | null => task.taskId;

    await agent.executeTaskAsync(task, mockSender, taskIdProvider, executionContext);

    const unknownToolWarnings = warnSpy.mock.calls
      .map((call: unknown[]): string => String(call[0]))
      .filter((msg: string): boolean => msg.includes("Unknown tool name"));

    expect(unknownToolWarnings.length).toBe(0);
  });

  it("should log a warning and skip unknown tool names", async () => {
    const task: IScheduledTask = createTask({
      tools: ["think", "websearch", "fake_tool"],
    });

    const mockSender: MessageSender = async (): Promise<string | null> => {
      return null;
    };

    const agent: CronAgent = CronAgent.getInstance();

    const executionContext: IExecutionContext = createExecutionContext();
    const taskIdProvider = (): string | null => task.taskId;

    await agent.executeTaskAsync(task, mockSender, taskIdProvider, executionContext);

    const warnMessages: string[] = warnSpy.mock.calls.map((call: unknown[]): string => String(call[0]));

    expect(warnMessages.some((msg: string): boolean => msg.includes("Unknown tool name \"websearch\""))).toBe(true);
    expect(warnMessages.some((msg: string): boolean => msg.includes("Unknown tool name \"fake_tool\""))).toBe(true);
  });

  it("should work with all valid tool names without warnings", async () => {
    const task: IScheduledTask = createTask({
      tools: ["think", "run_cmd", "searxng", "crawl4ai", "fetch_rss", "query_database", "send_message"],
    });

    const mockSender: MessageSender = async (): Promise<string | null> => {
      return null;
    };

    const agent: CronAgent = CronAgent.getInstance();

    const executionContext: IExecutionContext = createExecutionContext();
    const taskIdProvider = (): string | null => task.taskId;

    await agent.executeTaskAsync(task, mockSender, taskIdProvider, executionContext);

    const warnCalls = warnSpy.mock.calls;
    const toolWarnings = warnCalls.filter((call: unknown[]): boolean =>
      typeof call[0] === "string" && (call[0] as string).includes("Unknown tool")
    );
    expect(toolWarnings.length).toBe(0);
  });
});
