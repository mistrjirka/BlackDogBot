import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  getBaseDir,
  getConfigPath,
  getSkillsDir,
  getJobsDir,
  getKnowledgeDir,
  getLanceDbDir,
  getTimedDir,
  getLogsDir,
  getCacheDir,
  getPromptsDir,
  getPromptFragmentsDir,
  getSkillDir,
  getSkillStatePath,
  getTimedFilePath,
  getPromptFilePath,
  getWorkspaceDir,
  getRssStateDir,
  getRssStateFilePath,
  ensureDirectoryExistsAsync,
  ensureAllDirectoriesAsync,
} from "../../src/utils/paths.js";

//#region Helpers

let tempDir: string;
let originalDataDir: string | undefined;

async function setupTempDataAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-paths-test-"));
  originalDataDir = process.env.BLACKDOGBOT_DATA_DIR;
  vi.stubEnv("BLACKDOGBOT_DATA_DIR", path.join(tempDir, ".blackdogbot"));
}

async function cleanupTempDataAsync(): Promise<void> {
  vi.stubEnv("BLACKDOGBOT_DATA_DIR", originalDataDir);
  await fs.rm(tempDir, { recursive: true, force: true });
}

//#endregion Helpers

//#region Tests

describe("paths utility", () => {
  beforeEach(async () => {
    await setupTempDataAsync();
  });

  afterEach(async () => {
    await cleanupTempDataAsync();
  });

  it("uses the standard home directory when no override is configured", () => {
    vi.stubEnv("BLACKDOGBOT_DATA_DIR", undefined);
    expect(getBaseDir()).toBe(path.join(os.homedir(), ".blackdogbot"));
  });

  it("rejects relative and empty data directory overrides", () => {
    for (const value of ["relative/path", ""]) {
      vi.stubEnv("BLACKDOGBOT_DATA_DIR", value);
      expect(() => getBaseDir()).toThrow("absolute path");
    }
  });

  it("should return the explicitly configured data directory", () => {
    const base: string = getBaseDir();

    expect(base).toBe(path.join(tempDir, ".blackdogbot"));
  });

  it("should return the config path", () => {
    const configPath: string = getConfigPath();

    expect(configPath).toContain(".blackdogbot");
    expect(configPath).toContain("config.yaml");
  });

  it("should return skills directory", () => {
    const skillsDir: string = getSkillsDir();

    expect(skillsDir).toContain("skills");
  });

  it("should return jobs directory", () => {
    const jobsDir: string = getJobsDir();

    expect(jobsDir).toContain("jobs");
  });
  it("should return knowledge and lance directories", () => {
    const knowledgeDir: string = getKnowledgeDir();
    const lanceDir: string = getLanceDbDir();

    expect(knowledgeDir).toContain("knowledge");
    expect(lanceDir).toContain("lancedb");
    expect(lanceDir.startsWith(knowledgeDir)).toBe(true);
  });

  it("should return timed, logs, prompts, and prompt-fragments directories", () => {
    expect(getTimedDir()).toContain("timed");
    expect(getLogsDir()).toContain("logs");
    expect(getCacheDir()).toContain("cache");
    expect(getPromptsDir()).toContain("prompts");
    expect(getPromptFragmentsDir()).toContain("prompt-fragments");
  });

  it("should return workspace directory under base dir", () => {
    const workspaceDir: string = getWorkspaceDir();

    expect(workspaceDir).toContain("workspace");
    expect(workspaceDir.startsWith(getBaseDir())).toBe(true);
  });

  it("should return rss-state directory under base dir", () => {
    const rssStateDir: string = getRssStateDir();

    expect(rssStateDir).toContain("rss-state");
    expect(rssStateDir.startsWith(getBaseDir())).toBe(true);
  });

  it("should return rss-state file path as SHA-256 hash of URL", () => {
    const feedUrl: string = "https://example.com/feed.xml";
    const filePath: string = getRssStateFilePath(feedUrl);

    expect(filePath.startsWith(getRssStateDir())).toBe(true);
    expect(filePath).toMatch(/[a-f0-9]{64}\.json$/);

    // Same URL should produce the same path
    const filePath2: string = getRssStateFilePath(feedUrl);
    expect(filePath).toBe(filePath2);

    // Different URL should produce a different path
    const filePath3: string = getRssStateFilePath("https://example.com/other.xml");
    expect(filePath3).not.toBe(filePath);
  });

  it("should return skill-specific paths", () => {
    const skillDir: string = getSkillDir("my-skill");
    const skillStatePath: string = getSkillStatePath("my-skill");

    expect(skillDir).toContain("my-skill");
    expect(skillStatePath).toContain("state.json");
  });
  it("should return timed and prompt file paths", () => {
    const timedFilePath: string = getTimedFilePath("task-1");
    const promptFilePath: string = getPromptFilePath("main-agent");

    expect(timedFilePath).toContain("task-1.json");
    expect(promptFilePath).toContain("main-agent.md");
  });

  it("should create a directory via ensureDirectoryExistsAsync", async () => {
    const newDir: string = path.join(tempDir, "new-dir", "nested");

    await ensureDirectoryExistsAsync(newDir);

    const stat = await fs.stat(newDir);

    expect(stat.isDirectory()).toBe(true);
  });

  it("should create all standard directories via ensureAllDirectoriesAsync", async () => {
    await ensureAllDirectoriesAsync();

    // Verify a selection of directories exist
    const base: string = getBaseDir();
    const skillsDir: string = getSkillsDir();
    const timedDir: string = getTimedDir();
    const logsDir: string = getLogsDir();
    const promptsDir: string = getPromptsDir();
    const workspaceDir: string = getWorkspaceDir();
    const rssStateDir: string = getRssStateDir();

    for (const dir of [base, skillsDir, timedDir, logsDir, promptsDir, workspaceDir, rssStateDir]) {
      const stat = await fs.stat(dir);

      expect(stat.isDirectory()).toBe(true);
    }
  });
});

//#endregion Tests
