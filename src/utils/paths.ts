import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";

import * as litesql from "../helpers/litesql.js";

//#region Constants

const _BaseDirName: string = ".blackdogbot";
const _LegacyBaseDirName: string = ".betterclaw";
const DEFAULT_DATABASE = "blackdog";

//#endregion Constants

// Run migration as early as possible when paths module is loaded.
// Safe no-op when .blackdogbot already exists.
migrateLegacyBaseDirSync();

//#region Public functions

export function getBaseDir(): string {
  return path.join(os.homedir(), _BaseDirName);
}

export function getLegacyBaseDir(): string {
  return path.join(os.homedir(), _LegacyBaseDirName);
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

export function getCacheDir(): string {
  return path.join(getBaseDir(), "cache");
}

export function getJobLogsDir(): string {
  return path.join(getLogsDir(), "jobs");
}

export function getWorkspaceDir(): string {
  return path.join(getBaseDir(), "workspace");
}

export function getUploadsDir(): string {
  return path.join(getBaseDir(), "uploads");
}

export function getPromptsDir(): string {
  return path.join(getBaseDir(), "prompts");
}

export function getModelProfilesDir(): string {
  return path.join(getBaseDir(), "model-profiles");
}

export function getPromptFragmentsDir(): string {
  return path.join(getPromptsDir(), "prompt-fragments");
}

export function getSessionsDir(): string {
  return path.join(getBaseDir(), "sessions");
}

export function getSessionFilePath(chatId: string): string {
  return path.join(getSessionsDir(), `${chatId}.json`);
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

export function getChannelsFilePath(): string {
  return path.join(getBaseDir(), "channels.yaml");
}

export function getMcpServersFilePath(): string {
  return path.join(getBaseDir(), "mcp-servers.json");
}

export function getRssStateFilePath(feedUrl: string): string {
  const hash: string = crypto.createHash("sha256").update(feedUrl).digest("hex");
  return path.join(getRssStateDir(), `${hash}.json`);
}

export function getDatabasesDir(): string {
  return path.join(getBaseDir(), "databases");
}

export function getTelegramChatsFilePath(): string {
  return path.join(getBaseDir(), "known-telegram-chats.json");
}

export function getBrainInterfaceTokenFilePath(): string {
  return path.join(getBaseDir(), "brain-interface.token");
}

export function getModelsDir(): string {
  const envModelsDir: string | undefined =
    process.env.BLACKDOGBOT_MODELS_DIR ?? process.env.BETTERCLAW_MODELS_DIR;

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

export function migrateLegacyBaseDirSync(): void {
  const baseDir: string = getBaseDir();
  const legacyBaseDir: string = getLegacyBaseDir();

  if (fsSync.existsSync(baseDir)) {
    return;
  }

  if (fsSync.existsSync(legacyBaseDir)) {
    fsSync.renameSync(legacyBaseDir, baseDir);
  }
}

export async function migrateLegacyBaseDirAsync(): Promise<void> {
  const baseDir: string = getBaseDir();
  const legacyBaseDir: string = getLegacyBaseDir();

  try {
    await fs.access(baseDir);
    return;
  } catch {
    // Base dir does not exist yet.
  }

  try {
    await fs.access(legacyBaseDir);
    await fs.rename(legacyBaseDir, baseDir);
  } catch {
    // Legacy dir does not exist or rename failed; fallback directory creation happens below.
  }
}

export async function ensureAllDirectoriesAsync(): Promise<void> {
  await migrateLegacyBaseDirAsync();

  const directories: string[] = [
    getBaseDir(),
    getSkillsDir(),
    getJobsDir(),
    getKnowledgeDir(),
    getLanceDbDir(),
    getCronDir(),
    getLogsDir(),
    getCacheDir(),
    getJobLogsDir(),
    getWorkspaceDir(),
    getUploadsDir(),
    getRssStateDir(),
    getPromptsDir(),
    getPromptFragmentsDir(),
    getModelProfilesDir(),
    getDatabasesDir(),
    getSessionsDir(),
    getModelsDir(),
  ];

  for (const dir of directories) {
    await ensureDirectoryExistsAsync(dir);
  }
}

export async function ensureDefaultDatabaseAsync(): Promise<void> {
  await ensureDirectoryExistsAsync(getDatabasesDir());
  const existingDatabases = await litesql.listDatabasesAsync();
  const dbExists = existingDatabases.some((db) => db.name === DEFAULT_DATABASE);
  if (!dbExists) {
    await litesql.createDatabaseAsync(DEFAULT_DATABASE);
  }
}

export function getOldDatumBackupDir(): string {
  return path.join(process.cwd(), ".old.datumofthesave");
}

export function getCommitHashPath(): string {
  return path.join(getBaseDir(), ".commit-hash");
}

//#endregion Public functions
