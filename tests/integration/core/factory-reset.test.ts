import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { SchedulerService } from "../../../src/services/scheduler.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { factoryResetAsync } from "../../../src/services/factory-reset.service.js";

let tempDir: string;
let originalHome: string;


describe("factoryResetAsync", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-factory-reset-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const blackdogbotDir: string = path.join(tempDir, ".blackdogbot");

    await fs.mkdir(path.join(blackdogbotDir, "timed"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "workspace"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "jobs"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "cache"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "uploads"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "databases"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "rss-state"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "knowledge", "lancedb", "knowledge.lance", "data"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "prompts"), { recursive: true });
    await fs.mkdir(path.join(blackdogbotDir, "skills", "test-skill"), { recursive: true });

    await fs.writeFile(path.join(blackdogbotDir, "timed", "test-task.json"), JSON.stringify({ taskId: "test", name: "Test" }));
    await fs.writeFile(path.join(blackdogbotDir, "workspace", "testfile.txt"), "hello");
    await fs.writeFile(path.join(blackdogbotDir, "jobs", "test-job.json"), JSON.stringify({ id: "job-1" }));
    await fs.writeFile(path.join(blackdogbotDir, "cache", "capabilities.json"), "{}");
    await fs.writeFile(path.join(blackdogbotDir, "uploads", "uploaded.txt"), "payload");
    await fs.writeFile(path.join(blackdogbotDir, "databases", "test.db"), "");
    await fs.writeFile(path.join(blackdogbotDir, "rss-state", "somehash.json"), "{}");
    await fs.writeFile(path.join(blackdogbotDir, "logs", "blackdogbot-2026-01-01.log"), "log entry");
    await fs.writeFile(path.join(blackdogbotDir, "knowledge", "lancedb", "knowledge.lance", "data", "test.lance"), "data");
    await fs.writeFile(path.join(blackdogbotDir, "known-telegram-chats.json"), '["123456"]');
    await fs.writeFile(path.join(blackdogbotDir, "channels.yaml"), "channels: []\n");
    await fs.writeFile(path.join(blackdogbotDir, "brain-interface.token"), "test-token");
    await fs.writeFile(path.join(blackdogbotDir, ".commit-hash"), "abcdef");
    await fs.mkdir(path.join(blackdogbotDir, ".old.datumofthesave"), { recursive: true });
    await fs.writeFile(path.join(blackdogbotDir, ".old.datumofthesave", "._saved_at_123_prompt.md"), "backup");
    await fs.writeFile(path.join(blackdogbotDir, "prompts", "system-prompt.md"), "default prompt");
    await fs.writeFile(path.join(blackdogbotDir, "skills", "test-skill", "state.json"), "{}");
    await fs.writeFile(path.join(blackdogbotDir, "skills", "test-skill", "SKILL.md"), "# Test Skill");

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);

    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigPath: string = path.join(blackdogbotDir, "config.yaml");
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

  it("should wipe the timed directory", async () => {
    await factoryResetAsync();

    const timedDir: string = path.join(tempDir, ".blackdogbot", "timed");
    const files: string[] = await fs.readdir(timedDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the workspace directory", async () => {
    await factoryResetAsync();

    const workspaceDir: string = path.join(tempDir, ".blackdogbot", "workspace");
    const files: string[] = await fs.readdir(workspaceDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the jobs directory", async () => {
    await factoryResetAsync();

    const jobsDir: string = path.join(tempDir, ".blackdogbot", "jobs");
    const files: string[] = await fs.readdir(jobsDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the uploads directory", async () => {
    await factoryResetAsync();

    const uploadsDir: string = path.join(tempDir, ".blackdogbot", "uploads");
    const files: string[] = await fs.readdir(uploadsDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the cache directory", async () => {
    await factoryResetAsync();

    const cacheDir: string = path.join(tempDir, ".blackdogbot", "cache");
    const files: string[] = await fs.readdir(cacheDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the databases directory", async () => {
    await factoryResetAsync();

    const dbDir: string = path.join(tempDir, ".blackdogbot", "databases");
    const files: string[] = await fs.readdir(dbDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the logs directory", async () => {
    await factoryResetAsync();

    const logsDir: string = path.join(tempDir, ".blackdogbot", "logs");
    const files: string[] = await fs.readdir(logsDir);
    expect(files.length).toBe(0);
  });

  it("should wipe the RSS state directory", async () => {
    await factoryResetAsync();

    const rssDir: string = path.join(tempDir, ".blackdogbot", "rss-state");
    const files: string[] = await fs.readdir(rssDir);
    expect(files.length).toBe(0);
  });

  it("should fully wipe the knowledge directory including LanceDB files", async () => {
    await factoryResetAsync();

    const knowledgeDir: string = path.join(tempDir, ".blackdogbot", "knowledge");
    const lancedbPath: string = path.join(knowledgeDir, "lancedb", "knowledge.lance", "data", "test.lance");

    await expect(fs.access(lancedbPath)).rejects.toThrow();
  });

  it("should delete known-telegram-chats.json", async () => {
    await factoryResetAsync();

    const chatsFile: string = path.join(tempDir, ".blackdogbot", "known-telegram-chats.json");
    await expect(fs.access(chatsFile)).rejects.toThrow();
  });

  it("should delete channels.yaml", async () => {
    await factoryResetAsync();

    const channelsFile: string = path.join(tempDir, ".blackdogbot", "channels.yaml");
    await expect(fs.access(channelsFile)).rejects.toThrow();
  });

  it("should delete brain-interface.token", async () => {
    await factoryResetAsync();

    const tokenFile: string = path.join(tempDir, ".blackdogbot", "brain-interface.token");
    await expect(fs.access(tokenFile)).rejects.toThrow();
  });

  it("should delete .commit-hash", async () => {
    await factoryResetAsync();

    const commitHashFile: string = path.join(tempDir, ".blackdogbot", ".commit-hash");
    await expect(fs.access(commitHashFile)).rejects.toThrow();
  });

  it("should wipe the old prompt backup directory", async () => {
    await factoryResetAsync();

    const backupDir: string = path.join(tempDir, ".blackdogbot", ".old.datumofthesave");
    const files: string[] = await fs.readdir(backupDir);
    expect(files.length).toBe(0);
  });

  it("should delete skill state files but preserve skill definitions", async () => {
    await factoryResetAsync();

    const stateFile: string = path.join(tempDir, ".blackdogbot", "skills", "test-skill", "state.json");
    const skillFile: string = path.join(tempDir, ".blackdogbot", "skills", "test-skill", "SKILL.md");

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
