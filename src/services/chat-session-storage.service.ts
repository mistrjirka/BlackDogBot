/**
 * Chat session storage service - persists chat sessions to SQLite
 * so they survive daemon restarts.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { getDatabasesDir, ensureDirectoryExistsAsync } from "../utils/paths.js";
import { LoggerService } from "./logger.service.js";

const DB_NAME = "chat-sessions";
const DEFAULT_TTL_DAYS = 7;

export interface IChatSessionData {
  chatId: string;
  messages: string; // JSON array of ModelMessage
  lastActivityAt: number;
  jobCreationMode: string | null; // JSON or null
}

export class ChatSessionStorageService {
  private static _instance: ChatSessionStorageService | null;
  private _db: Database.Database | null;
  private _ttlMs: number;

  private constructor() {
    this._db = null;
    this._ttlMs = DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  public static getInstance(): ChatSessionStorageService {
    if (!ChatSessionStorageService._instance) {
      ChatSessionStorageService._instance = new ChatSessionStorageService();
    }
    return ChatSessionStorageService._instance;
  }

  /**
   * Initialize the storage service and create tables if needed.
   */
  public async initializeAsync(ttlDays: number = DEFAULT_TTL_DAYS): Promise<void> {
    const logger = LoggerService.getInstance();
    const dbDir = getDatabasesDir();
    await ensureDirectoryExistsAsync(dbDir);

    const dbPath = path.join(dbDir, `${DB_NAME}.db`);
    this._db = new Database(dbPath);
    this._ttlMs = ttlDays * 24 * 60 * 60 * 1000;

    // Enable WAL mode for better concurrent access
    this._db.pragma("journal_mode = WAL");

    // Create table if not exists
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        chat_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL DEFAULT '[]',
        last_activity_at INTEGER NOT NULL,
        job_creation_mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_activity
        ON chat_sessions(last_activity_at);
    `);

    // Clean up expired sessions
    this._cleanupExpiredSessions();

    logger.info("Chat session storage initialized", { path: dbPath, ttlDays });
  }

  /**
   * Load a chat session from storage.
   */
  public loadSession(chatId: string): IChatSessionData | null {
    if (!this._db) {
      return null;
    }

    try {
      const stmt = this._db.prepare(
        "SELECT chat_id, messages, last_activity_at, job_creation_mode FROM chat_sessions WHERE chat_id = ?"
      );
      const row = stmt.get(chatId) as IChatSessionData | undefined;

      if (!row) {
        return null;
      }

      // Check if expired
      if (Date.now() - row.lastActivityAt > this._ttlMs) {
        this.deleteSession(chatId);
        return null;
      }

      return row;
    } catch (error) {
      const logger = LoggerService.getInstance();
      logger.error("Failed to load chat session", { chatId, error: String(error) });
      return null;
    }
  }

  /**
   * Save a chat session to storage.
   */
  public saveSession(
    chatId: string,
    messages: string,
    jobCreationMode: string | null = null
  ): void {
    if (!this._db) {
      return;
    }

    const now = Date.now();

    try {
      const stmt = this._db.prepare(`
        INSERT INTO chat_sessions (chat_id, messages, last_activity_at, job_creation_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          messages = excluded.messages,
          last_activity_at = excluded.last_activity_at,
          job_creation_mode = excluded.job_creation_mode,
          updated_at = excluded.updated_at
      `);

      stmt.run(chatId, messages, now, jobCreationMode, now, now);
    } catch (error) {
      const logger = LoggerService.getInstance();
      logger.error("Failed to save chat session", { chatId, error: String(error) });
    }
  }

  /**
   * Delete a chat session from storage.
   */
  public deleteSession(chatId: string): void {
    if (!this._db) {
      return;
    }

    try {
      const stmt = this._db.prepare("DELETE FROM chat_sessions WHERE chat_id = ?");
      stmt.run(chatId);
    } catch (error) {
      const logger = LoggerService.getInstance();
      logger.error("Failed to delete chat session", { chatId, error: String(error) });
    }
  }

  /**
   * Get all active session IDs.
   */
  public getAllSessionIds(): string[] {
    if (!this._db) {
      return [];
    }

    try {
      const stmt = this._db.prepare(
        "SELECT chat_id FROM chat_sessions WHERE (last_activity_at + ?) > ?"
      );
      const rows = stmt.all(this._ttlMs, Date.now()) as { chat_id: string }[];
      return rows.map((r) => r.chat_id);
    } catch {
      return [];
    }
  }

  /**
   * Get count of active sessions.
   */
  public getSessionCount(): number {
    if (!this._db) {
      return 0;
    }

    try {
      const stmt = this._db.prepare(
        "SELECT COUNT(*) as count FROM chat_sessions WHERE (last_activity_at + ?) > ?"
      );
      const row = stmt.get(this._ttlMs, Date.now()) as { count: number } | undefined;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Clean up expired sessions.
   */
  private _cleanupExpiredSessions(): void {
    if (!this._db) {
      return;
    }

    try {
      const cutoff = Date.now() - this._ttlMs;
      const stmt = this._db.prepare("DELETE FROM chat_sessions WHERE last_activity_at < ?");
      const result = stmt.run(cutoff);

      if (result.changes > 0) {
        const logger = LoggerService.getInstance();
        logger.info("Cleaned up expired chat sessions", { count: result.changes });
      }
    } catch (error) {
      const logger = LoggerService.getInstance();
      logger.error("Failed to clean up expired sessions", { error: String(error) });
    }
  }

  /**
   * Close the database connection.
   */
  public close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}
