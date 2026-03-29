#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseMessage } from "@langchain/core/messages";
import { modelMessagesToLangChain } from "../src/utils/message-converter";
import Database from "better-sqlite3";

interface IVercelPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

interface IModelMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | IVercelPart[];
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolCallId?: string;
}

interface Session {
  messages: IModelMessage[];
  lastActivityAt: number;
}

const SESSIONS_DIR = path.join(os.homedir(), ".blackdogbot/sessions");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function bufferReviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && "$type" in (value as Record<string, unknown>) && (value as Record<string, unknown>)["$type"] === "Buffer") {
    const data = (value as Record<string, unknown>)["data"];
    if (Array.isArray(data)) {
      return Buffer.from(data as number[]);
    }
  }
  return value;
}

function readSessions(): Array<{ chatId: string; session: Session }> {
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error(`Sessions directory not found: ${SESSIONS_DIR}`);
    return [];
  }

  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const sessions: Array<{ chatId: string; session: Session }> = [];

  for (const file of files) {
    const chatId = path.basename(file, ".json");
    const filePath = path.join(SESSIONS_DIR, file);

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const session = JSON.parse(content, bufferReviver) as Session;
      sessions.push({ chatId, session });
    } catch (err) {
      console.error(`Failed to read session ${chatId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return sessions;
}

function getSessionAge(session: Session): number {
  return Date.now() - session.lastActivityAt;
}

function shouldSkip(session: Session): boolean {
  return getSessionAge(session) > THIRTY_DAYS_MS;
}

function shouldSummarize(session: Session): boolean {
  const age = getSessionAge(session);
  return age >= SEVEN_DAYS_MS && age <= THIRTY_DAYS_MS;
}

async function summarizeMessages(messages: IModelMessage[]): Promise<IModelMessage[]> {
  const recent = messages.slice(-10);
  const summary: IModelMessage = {
    role: "system",
    content: `[Earlier conversation summary - ${messages.length - recent.length} messages removed during migration]`,
  };

  return [summary, ...recent];
}

async function migrateSession(
  saver: SqliteSaver,
  chatId: string,
  session: Session,
): Promise<boolean> {
  try {
    const age = getSessionAge(session);
    let messagesToMigrate: IModelMessage[] = session.messages;

    if (shouldSkip(session)) {
      console.log(`  Skipping ${chatId} (${Math.round(age / (24 * 60 * 60 * 1000))} days old)`);
      return false;
    }

    if (shouldSummarize(session)) {
      console.log(`  Summarizing ${chatId} (${Math.round(age / (24 * 60 * 60 * 1000))} days old)`);
      messagesToMigrate = await summarizeMessages(session.messages);
    } else {
      console.log(`  Migrating ${chatId} (${Math.round(age / (24 * 60 * 60 * 1000))} days old)`);
    }

    const lcMessages: BaseMessage[] = modelMessagesToLangChain(messagesToMigrate);

    const config = { configurable: { thread_id: chatId } };
    const checkpoint = {
      v: 1,
      id: `migrated-${Date.now()}`,
      ts: new Date(session.lastActivityAt).toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      channel_data: {},
    };
    const metadata = {
      source: "update" as const,
      step: 0,
      parents: {},
      migrant: true,
      migrated_at: new Date().toISOString(),
      original_last_activity: new Date(session.lastActivityAt).toISOString(),
      message_count: lcMessages.length,
    };

    await saver.put(config, checkpoint, metadata);

    console.log(`  Successfully migrated ${chatId} with ${lcMessages.length} messages`);
    return true;
  } catch (err) {
    console.error(`  Failed to migrate ${chatId}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");

  console.log("=== Session Migration Tool ===\n");
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  const sessions = readSessions();
  if (sessions.length === 0) {
    console.log("No sessions found to migrate.");
    return;
  }

  console.log(`Found ${sessions.length} session(s)\n`);

  const skipped = sessions.filter((s) => shouldSkip(s.session)).length;
  const toSummarize = sessions.filter((s) => shouldSummarize(s.session)).length;
  const toMigrate = sessions.length - skipped - toSummarize;

  console.log("Migration plan:");
  console.log(`  - Full migration: ${toMigrate}`);
  console.log(`  - Summarize first: ${toSummarize}`);
  console.log(`  - Skip (too old): ${skipped}`);
  console.log("");

  if (dryRun) {
    console.log("Dry run complete. No changes made.");
    return;
  }

  const dbPath = path.join(os.homedir(), ".blackdogbot/migration.db");
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  console.log(`Using database: ${dbPath}\n`);

  const db = new Database(dbPath);
  const saver = new SqliteSaver(db);
  await (saver as any).setup();

  let success = 0;
  let failed = 0;

  for (const { chatId, session } of sessions) {
    if (verbose) {
      console.log(`Processing ${chatId}...`);
    }
    const result = await migrateSession(saver, chatId, session);
    if (result) {
      success++;
    } else {
      failed++;
    }
  }

  console.log("\n=== Migration Complete ===");
  console.log(`Successful: ${success}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${sessions.length}`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
