import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";

//#region Constants

const _BaseDirName: string = ".betterclaw";

//#endregion Constants

//#region Public functions

export function getBaseDir(): string {
  return path.join(os.homedir(), _BaseDirName);
}

export function getConfigPath(): string {
  return path.join(getBaseDir(), "config.yaml");
}

export function getSkillsDir(): string {
  return path.join(getBaseDir(), "skills");
}

export function getJobsDir(): string {
  return path.join(getBaseDir(), "jobs");
}

export function getJobDir(jobId: string): string {
  return path.join(getJobsDir(), jobId);
}

export function getJobNodesDir(jobId: string): string {
  return path.join(getJobDir(jobId), "nodes");
}

export function getJobTestsDir(jobId: string): string {
  return path.join(getJobDir(jobId), "tests");
}

export function getKnowledgeDir(): string {
  return path.join(getBaseDir(), "knowledge");
}

export function getLanceDbDir(): string {
  return path.join(getKnowledgeDir(), "lancedb");
}

export function getCronDir(): string {
  return path.join(getBaseDir(), "cron");
}

export function getLogsDir(): string {
  return path.join(getBaseDir(), "logs");
}

export function getWorkspaceDir(): string {
  return path.join(getBaseDir(), "workspace");
}

export function getPromptsDir(): string {
  return path.join(getBaseDir(), "prompts");
}

export function getPromptFragmentsDir(): string {
  return path.join(getPromptsDir(), "prompt-fragments");
}

export function getSkillDir(skillName: string): string {
  return path.join(getSkillsDir(), skillName);
}

export function getSkillFilePath(skillName: string): string {
  return path.join(getSkillDir(skillName), "SKILL.md");
}

export function getSkillStatePath(skillName: string): string {
  return path.join(getSkillDir(skillName), "state.json");
}

export function getNodeFilePath(jobId: string, nodeId: string): string {
  return path.join(getJobNodesDir(jobId), `${nodeId}.json`);
}

export function getNodeTestFilePath(jobId: string, nodeId: string): string {
  return path.join(getJobTestsDir(jobId), `${nodeId}.json`);
}

export function getCronFilePath(taskId: string): string {
  return path.join(getCronDir(), `${taskId}.json`);
}

export function getPromptFilePath(promptName: string): string {
  return path.join(getPromptsDir(), `${promptName}.md`);
}

export function getRssStateDir(): string {
  return path.join(getBaseDir(), "rss-state");
}

export function getRssStateFilePath(feedUrl: string): string {
  const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
  return path.join(getRssStateDir(), `${hash}.json`);
}

export function getDatabasesDir(): string {
  return path.join(getBaseDir(), "databases");
}

export function getModelsDir(): string {
  const envModelsDir: string | undefined = process.env.BETTERCLAW_MODELS_DIR;

  if (envModelsDir && envModelsDir.trim().length > 0) {
    return envModelsDir;
  }

  return path.join(getBaseDir(), "models");
}

export function getDatabasePath(databaseName: string): string {
  return path.join(getDatabasesDir(), `${databaseName}.db`);
}

export async function ensureDirectoryExistsAsync(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureAllDirectoriesAsync(): Promise<void> {
  const directories: string[] = [
    getBaseDir(),
    getSkillsDir(),
    getJobsDir(),
    getKnowledgeDir(),
    getLanceDbDir(),
    getCronDir(),
    getLogsDir(),
    getWorkspaceDir(),
    getRssStateDir(),
    getPromptsDir(),
    getPromptFragmentsDir(),
    getDatabasesDir(),
    getModelsDir(),
  ];

  for (const dir of directories) {
    await ensureDirectoryExistsAsync(dir);
  }
}

//#endregion Public functions
