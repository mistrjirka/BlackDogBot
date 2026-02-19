import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  getBaseDir,
  getConfigPath,
  getSkillsDir,
  getJobsDir,
  getJobDir,
  getJobNodesDir,
  getJobTestsDir,
  getKnowledgeDir,
  getLanceDbDir,
  getCronDir,
  getLogsDir,
  getPromptsDir,
  getPromptFragmentsDir,
  getSkillDir,
  getSkillFilePath,
  getSkillStatePath,
  getNodeFilePath,
  getNodeTestFilePath,
  getCronFilePath,
  getPromptFilePath,
  getWorkspaceDir,
  ensureDirectoryExistsAsync,
  ensureAllDirectoriesAsync,
} from "../../src/utils/paths.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-paths-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

//#endregion Helpers

//#region Tests

describe("paths utility", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
  });

  afterEach(async () => {
    await cleanupTempHomeAsync();
  });

  it("should return the base directory under HOME", () => {
    const base: string = getBaseDir();

    expect(base).toBe(path.join(tempDir, ".betterclaw"));
  });

  it("should return the config path", () => {
    const configPath: string = getConfigPath();

    expect(configPath).toContain(".betterclaw");
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

  it("should return job-specific directory", () => {
    const jobDir: string = getJobDir("job-123");

    expect(jobDir).toContain("job-123");
    expect(jobDir).toContain("jobs");
  });

  it("should return job nodes directory", () => {
    const nodesDir: string = getJobNodesDir("job-123");

    expect(nodesDir).toContain("nodes");
    expect(nodesDir).toContain("job-123");
  });

  it("should return job tests directory", () => {
    const testsDir: string = getJobTestsDir("job-123");

    expect(testsDir).toContain("tests");
    expect(testsDir).toContain("job-123");
  });

  it("should return knowledge and lance directories", () => {
    const knowledgeDir: string = getKnowledgeDir();
    const lanceDir: string = getLanceDbDir();

    expect(knowledgeDir).toContain("knowledge");
    expect(lanceDir).toContain("lancedb");
    expect(lanceDir.startsWith(knowledgeDir)).toBe(true);
  });

  it("should return cron, logs, prompts, and prompt-fragments directories", () => {
    expect(getCronDir()).toContain("cron");
    expect(getLogsDir()).toContain("logs");
    expect(getPromptsDir()).toContain("prompts");
    expect(getPromptFragmentsDir()).toContain("prompt-fragments");
  });

  it("should return workspace directory under base dir", () => {
    const workspaceDir: string = getWorkspaceDir();

    expect(workspaceDir).toContain("workspace");
    expect(workspaceDir.startsWith(getBaseDir())).toBe(true);
  });

  it("should return skill-specific paths", () => {
    const skillDir: string = getSkillDir("my-skill");
    const skillFilePath: string = getSkillFilePath("my-skill");
    const skillStatePath: string = getSkillStatePath("my-skill");

    expect(skillDir).toContain("my-skill");
    expect(skillFilePath).toContain("SKILL.md");
    expect(skillStatePath).toContain("state.json");
  });

  it("should return node file paths", () => {
    const nodeFilePath: string = getNodeFilePath("job-1", "node-1");
    const nodeTestFilePath: string = getNodeTestFilePath("job-1", "node-1");

    expect(nodeFilePath).toContain("node-1.json");
    expect(nodeTestFilePath).toContain("node-1.json");
    expect(nodeFilePath).toContain("nodes");
    expect(nodeTestFilePath).toContain("tests");
  });

  it("should return cron and prompt file paths", () => {
    const cronFilePath: string = getCronFilePath("task-1");
    const promptFilePath: string = getPromptFilePath("main-agent");

    expect(cronFilePath).toContain("task-1.json");
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
    const cronDir: string = getCronDir();
    const logsDir: string = getLogsDir();
    const promptsDir: string = getPromptsDir();
    const workspaceDir: string = getWorkspaceDir();

    for (const dir of [base, skillsDir, cronDir, logsDir, promptsDir, workspaceDir]) {
      const stat = await fs.stat(dir);

      expect(stat.isDirectory()).toBe(true);
    }
  });
});

//#endregion Tests
