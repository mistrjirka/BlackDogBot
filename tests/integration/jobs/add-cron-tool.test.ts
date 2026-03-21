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
import { addCronTool } from "../../../src/tools/add-cron.tool.js";
import { addCronToolInputSchema } from "../../../src/shared/schemas/tool-schemas.js";
import { generateObjectWithRetryAsync } from "../../../src/utils/llm-retry.js";

let tempDir: string;
let originalHome: string;


interface IAddCronResult {
  taskId: string;
  success: boolean;
  error?: string;
}

async function execAddCronTool(args: {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  scheduleType: "once" | "interval" | "cron";
  scheduleRunAt?: string;
  scheduleIntervalMs?: number;
  scheduleCron?: string;
  notifyUser: boolean;
}): Promise<IAddCronResult> {
  return await (addCronTool as any).execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  ) as IAddCronResult;
}

describe("addCronTool", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-addcron-test-"));
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

    const schedulerService: SchedulerService = SchedulerService.getInstance();
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

  it("should create a valid cron task with correct fields", async () => {
    const result = await execAddCronTool({
      name: "Test Task",
      description: "test",
      instructions: "Use the think tool to think about the number 42, then finish.",
      tools: ["think"],
      scheduleType: "interval",
      scheduleIntervalMs: 60000,
      notifyUser: false,
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(result.taskId.length).toBeGreaterThan(0);

    const cronDir: string = path.join(tempDir, ".betterclaw", "cron");
    const files: string[] = await fs.readdir(cronDir);
    const taskFile: string = files.find((f) => f.endsWith(".json"))!;
    const taskContent: string = await fs.readFile(path.join(cronDir, taskFile), "utf-8");
    const task = JSON.parse(taskContent);

    expect(task.name).toBe("Test Task");
    expect(task.notifyUser).toBe(false);
    expect(task.tools).toContain("think");
    expect(task.enabled).toBe(true);
    expect(task.schedule.type).toBe("interval");
  });

  it("should reject invalid tool names at runtime", async () => {
    const result = await execAddCronTool({
      name: "Bad Task",
      description: "Invalid tool test task",
      instructions: "Search the web for news.",
      tools: ["websearch", "fake_tool"],
      scheduleType: "cron",
      scheduleCron: "0 * * * *",
      notifyUser: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid tool name(s)");
    expect(result.error).toContain("websearch");
    expect(result.error).toContain("fake_tool");
  });

  it("should accept all valid tool names", async () => {
    const result = await execAddCronTool({
      name: "Valid Tools Task",
      description: "Search for AI news, fetch RSS, store in DB, and notify user",
      instructions:
        "1. Use think to plan the execution order. " +
        "2. Use searxng to search the web for 'artificial intelligence 2026'. Take the top 3 result titles and URLs from the search output. " +
        "3. Use fetch_rss to fetch the Hacker News RSS feed at https://news.ycombinator.com/rss. Take the top 3 item titles and URLs from the feed. " +
        "4. Use write_table_articles to insert each article into the 'news' database table 'articles' (columns: id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL, source TEXT NOT NULL, fetched_at TEXT NOT NULL). Use source='searxng' for searxng results and source='rss' for RSS items. Set fetched_at to the current ISO timestamp. " +
        "5. Use send_message to send the user a numbered list of all stored article titles.",
      tools: ["think", "searxng", "fetch_rss", "write_table_articles", "send_message"],
      scheduleType: "cron",
      scheduleCron: "0 * * * *",
      notifyUser: false,
    });

    if (!result.success) {
      console.error("LLM verifier rejected 'should accept all valid tool names' with error:", result.error);
    }
    expect(result.success).toBe(true);
  });

  it("should reject ambiguous instructions via verifier", async () => {
    vi.mocked(generateObjectWithRetryAsync).mockResolvedValueOnce({
      object: {
        isClear: false,
        missingContext: "Missing concrete context",
      },
    } as any);

    const result = await execAddCronTool({
      name: "Ambiguous Task",
      description: "Ambiguous instructions test task",
      instructions: "Do what we discussed earlier",
      tools: ["think"],
      scheduleType: "interval",
      scheduleIntervalMs: 60000,
      notifyUser: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ambiguous|missing context|CRON REJECTED/i);
  });

  it("should require notifyUser field at schema level", () => {
    const parseResult = addCronToolInputSchema.safeParse({
      name: "x",
      instructions: "y",
      tools: ["think"],
      scheduleType: "cron",
      scheduleCron: "* * * * *",
    });

    expect(parseResult.success).toBe(false);
    expect(parseResult.error?.issues.some((i) => i.path.includes("notifyUser"))).toBe(true);
  });

  it("should properly pass notifyUser=true through to the saved task", async () => {
    const result = await execAddCronTool({
      name: "Notify Task",
      description: "Notify user passthrough test task",
      instructions: "Think about the word hello.",
      tools: ["think"],
      scheduleType: "interval",
      scheduleIntervalMs: 60000,
      notifyUser: true,
    });

    expect(result.success).toBe(true);

    const cronDir: string = path.join(tempDir, ".betterclaw", "cron");
    const files: string[] = await fs.readdir(cronDir);
    const taskFile: string = files.find((f) => f.endsWith(".json"))!;
    const taskContent: string = await fs.readFile(path.join(cronDir, taskFile), "utf-8");
    const task = JSON.parse(taskContent);

    if (task.notifyUser !== true) {
      console.error("LLM verifier may have rejected, task.notifyUser =", task.notifyUser);
    }

    expect(task.notifyUser).toBe(true);
  });

  it("should reject cron schedule when scheduleCron is missing", () => {
    const parseResult = addCronToolInputSchema.safeParse({
      name: "Cron Missing Expression",
      description: "Should fail",
      instructions: "Run task",
      tools: ["think"],
      scheduleType: "cron",
      notifyUser: false,
    });

    expect(parseResult.success).toBe(false);
    expect(parseResult.error?.issues.some((i) => i.path.join(".") === "scheduleCron")).toBe(true);
  });

  it("should reject once schedule when scheduleRunAt is missing", () => {
    const parseResult = addCronToolInputSchema.safeParse({
      name: "Once Missing RunAt",
      description: "Should fail",
      instructions: "Run task",
      tools: ["think"],
      scheduleType: "once",
      notifyUser: false,
    });

    expect(parseResult.success).toBe(false);
    expect(parseResult.error?.issues.some((i) => i.path.join(".") === "scheduleRunAt")).toBe(true);
  });

  it("should reject interval schedule when scheduleIntervalMs is missing", () => {
    const parseResult = addCronToolInputSchema.safeParse({
      name: "Interval Missing Ms",
      description: "Should fail",
      instructions: "Run task",
      tools: ["think"],
      scheduleType: "interval",
      notifyUser: false,
    });

    expect(parseResult.success).toBe(false);
    expect(parseResult.error?.issues.some((i) => i.path.join(".") === "scheduleIntervalMs")).toBe(true);
  });

  it("should persist cron expression in the saved task JSON", async () => {
    const cronExpression: string = "15 */3 * * *";
    const result = await execAddCronTool({
      name: "Cron Expression Persistence",
      description: "Validate cron expression is saved",
      instructions: "Use think tool and finish.",
      tools: ["think"],
      scheduleType: "cron",
      scheduleCron: cronExpression,
      notifyUser: false,
    });

    expect(result.success).toBe(true);
    expect(result.taskId.length).toBeGreaterThan(0);

    const cronFilePath: string = path.join(tempDir, ".betterclaw", "cron", `${result.taskId}.json`);
    const savedContent: string = await fs.readFile(cronFilePath, "utf-8");
    const savedTask = JSON.parse(savedContent);

    expect(savedTask.schedule.type).toBe("cron");
    expect(savedTask.schedule.expression).toBe(cronExpression);
  });
});
