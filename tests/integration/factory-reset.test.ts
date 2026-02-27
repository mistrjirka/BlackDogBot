import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../src/services/config.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { SchedulerService } from "../../src/services/scheduler.service.js";
import { PromptService } from "../../src/services/prompt.service.js";
import { factoryResetAsync } from "../../src/services/factory-reset.service.js";

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (SchedulerService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
}

describe("factoryResetAsync", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-factory-reset-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const betterclawDir: string = path.join(tempDir, ".betterclaw");

    await fs.mkdir(path.join(betterclawDir, "cron"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "workspace"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "databases"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "rss-state"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "knowledge", "lancedb", "knowledge.lance", "data"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "prompts"), { recursive: true });
    await fs.mkdir(path.join(betterclawDir, "skills", "test-skill"), { recursive: true });

    await fs.writeFile(path.join(betterclawDir, "cron", "test-task.json"), JSON.stringify({ taskId: "test", name: "Test" }));
    await fs.writeFile(path.join(betterclawDir, "workspace", "testfile.txt"), "hello");
    await fs.writeFile(path.join(betterclawDir, "databases", "test.db"), "");
    await fs.writeFile(path.join(betterclawDir, "rss-state", "somehash.json"), "{}");
    await fs.writeFile(path.join(betterclawDir, "logs", "betterclaw-2026-01-01.log"), "log entry");
    await fs.writeFile(path.join(betterclawDir, "knowledge", "lancedb", "knowledge.lance", "data", "test.lance"), "data");
    await fs.writeFile(path.join(betterclawDir, "known-telegram-chats.json"), '["123456"]');
    await fs.writeFile(path.join(betterclawDir, "prompts", "system-prompt.md"), "default prompt");
    await fs.writeFile(path.join(betterclawDir, "skills", "test-skill", "state.json"), "{}");
    await fs.writeFile(path.join(betterclawDir, "skills", "test-skill", "SKILL.md"), "# Test Skill");

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigPath: string = path.join(betterclawDir, "config.yaml");
    await fs.cp(realConfigPath, tempConfigPath);

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

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

  it("should wipe the cron directory", async () => {
    await factoryResetAsync();

    const cronDir: string = path.join(tempDir, ".betterclaw", "cron");
    const files: string[] = await fs.readdir(cronDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the workspace directory", async () => {
    await factoryResetAsync();

    const workspaceDir: string = path.join(tempDir, ".betterclaw", "workspace");
    const files: string[] = await fs.readdir(workspaceDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the databases directory", async () => {
    await factoryResetAsync();

    const dbDir: string = path.join(tempDir, ".betterclaw", "databases");
    const files: string[] = await fs.readdir(dbDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the logs directory", async () => {
    await factoryResetAsync();

    const logsDir: string = path.join(tempDir, ".betterclaw", "logs");
    const files: string[] = await fs.readdir(logsDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the RSS state directory", async () => {
    await factoryResetAsync();

    const rssDir: string = path.join(tempDir, ".betterclaw", "rss-state");
    const files: string[] = await fs.readdir(rssDir);
    expect(files.length).toBe(0);
  });

  it("should fully wipe the knowledge directory including LanceDB files", async () => {
    await factoryResetAsync();

    const knowledgeDir: string = path.join(tempDir, ".betterclaw", "knowledge");
    const lancedbPath: string = path.join(knowledgeDir, "lancedb", "knowledge.lance", "data", "test.lance");

    await expect(fs.access(lancedbPath)).rejects.toThrow();
  });

  it("should delete known-telegram-chats.json", async () => {
    await factoryResetAsync();

    const chatsFile: string = path.join(tempDir, ".betterclaw", "known-telegram-chats.json");
    await expect(fs.access(chatsFile)).rejects.toThrow();
  });

  it("should delete skill state files but preserve skill definitions", async () => {
    await factoryResetAsync();

    const stateFile: string = path.join(tempDir, ".betterclaw", "skills", "test-skill", "state.json");
    const skillFile: string = path.join(tempDir, ".betterclaw", "skills", "test-skill", "SKILL.md");

    await expect(fs.access(stateFile)).rejects.toThrow();

    const skillContent: string = await fs.readFile(skillFile, "utf-8");
    expect(skillContent).toBe("# Test Skill");
  });

  it("should return success: true with empty errors array", async () => {
    const result = await factoryResetAsync();

    expect(result.success).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});
