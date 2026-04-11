import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { LoggerService } from "./logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { getTelegramOutboxDbPath } from "../utils/paths.js";

export type TelegramOutboxStatus = "pending" | "sent" | "permanent_failed" | "dropped_by_cap";

export interface ITelegramOutboxMessage {
  id: string;
  chatId: string;
  message: string;
  attempts: number;
}

export class TelegramOutboxService {
  //#region Data members

  private static _instance: TelegramOutboxService | null;
  private _db: Database.Database | null;
  private _logger: LoggerService;
  private _maxPendingPerChat: number;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._db = null;
    this._logger = LoggerService.getInstance();
    this._maxPendingPerChat = 10;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): TelegramOutboxService {
    if (!TelegramOutboxService._instance) {
      TelegramOutboxService._instance = new TelegramOutboxService();
    }

    return TelegramOutboxService._instance;
  }

  public async initializeAsync(maxPendingPerChat: number = 10): Promise<void> {
    if (this._db !== null) {
      this._maxPendingPerChat = Math.max(1, maxPendingPerChat);
      return;
    }

    this._maxPendingPerChat = Math.max(1, maxPendingPerChat);
    const dbPath: string = getTelegramOutboxDbPath();
    const dbDir: string = dirname(dbPath);
    if (!existsSync(dbDir)) {
      await mkdir(dbDir, { recursive: true });
    }

    this._db = new Database(dbPath);
    this._db.pragma("journal_mode = WAL");

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_telegram_outbox_chat_status_created
      ON telegram_outbox(chat_id, status, created_at);
    `);
  }

  public isInitialized(): boolean {
    return this._db !== null;
  }

  public enqueuePendingMessage(chatId: string, message: string, error: string): string {
    this._ensureInitialized();
    const nowIso: string = new Date().toISOString();
    const id: string = this._generateOutboxId(chatId, nowIso);

    this._db!.prepare(
      `INSERT INTO telegram_outbox (id, chat_id, message, status, created_at, updated_at, attempts, next_attempt_at, last_error)
       VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?)`
    ).run(id, chatId, message, nowIso, nowIso, nowIso, error);

    this._enforcePendingCap(chatId);

    this._safeWarn("Queued Telegram message in outbox", {
      chatId,
      id,
      error,
      maxPendingPerChat: this._maxPendingPerChat,
    });

    return id;
  }

  public close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  public getDuePendingMessages(limit: number = 20): ITelegramOutboxMessage[] {
    this._ensureInitialized();
    const nowIso: string = new Date().toISOString();

    const rows = this._db!
      .prepare(
        `SELECT id, chat_id, message, attempts
         FROM telegram_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(nowIso, Math.max(1, limit)) as Array<{ id: string; chat_id: string; message: string; attempts: number }>;

    return rows.map((row): ITelegramOutboxMessage => ({
      id: row.id,
      chatId: row.chat_id,
      message: row.message,
      attempts: row.attempts,
    }));
  }

  public markSent(id: string): void {
    this._ensureInitialized();
    const nowIso: string = new Date().toISOString();
    this._db!
      .prepare(
        `UPDATE telegram_outbox
         SET status = 'sent', updated_at = ?, last_error = NULL
         WHERE id = ?`
      )
      .run(nowIso, id);
  }

  public markPermanentFailed(id: string, error: string): void {
    this._ensureInitialized();
    const nowIso: string = new Date().toISOString();
    this._db!
      .prepare(
        `UPDATE telegram_outbox
         SET status = 'permanent_failed', updated_at = ?, last_error = ?
         WHERE id = ?`
      )
      .run(nowIso, error, id);
  }

  public reschedulePending(id: string, previousAttempts: number, error: string): void {
    this._ensureInitialized();
    const attempts: number = previousAttempts + 1;
    const backoffSeconds: number = this._getBackoffSeconds(attempts);
    const nowMs: number = Date.now();
    const nextAttemptIso: string = new Date(nowMs + backoffSeconds * 1000).toISOString();
    const nowIso: string = new Date(nowMs).toISOString();

    this._db!
      .prepare(
        `UPDATE telegram_outbox
         SET attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
         WHERE id = ?`
      )
      .run(attempts, nextAttemptIso, nowIso, error, id);
  }

  //#endregion Public methods

  //#region Private methods

  private _ensureInitialized(): void {
    if (!this._db) {
      throw new Error("TelegramOutboxService is not initialized.");
    }
  }

  private _enforcePendingCap(chatId: string): void {
    try {
      const pendingRows = this._db!
        .prepare(
          `SELECT id FROM telegram_outbox
           WHERE chat_id = ? AND status = 'pending'
           ORDER BY created_at DESC`
        )
        .all(chatId) as Array<{ id: string }>;

      if (pendingRows.length <= this._maxPendingPerChat) {
        return;
      }

      const toDrop = pendingRows.slice(this._maxPendingPerChat).map((row): string => row.id);
      const nowIso: string = new Date().toISOString();

      const dropStmt = this._db!.prepare(
        `UPDATE telegram_outbox
         SET status = 'dropped_by_cap', updated_at = ?, last_error = ?
         WHERE id = ?`
      );

      const transaction = this._db!.transaction((ids: string[]): void => {
        for (const id of ids) {
          dropStmt.run(nowIso, "Dropped due to per-chat pending cap", id);
        }
      });

      transaction(toDrop);

      this._safeWarn("Dropped queued Telegram messages due to per-chat cap", {
        chatId,
        droppedCount: toDrop.length,
        maxPendingPerChat: this._maxPendingPerChat,
      });
    } catch (error: unknown) {
      this._safeError("Failed to enforce Telegram outbox pending cap", {
        chatId,
        error: extractErrorMessage(error),
      });
    }
  }

  private _generateOutboxId(chatId: string, nowIso: string): string {
    const timestamp = nowIso.replace(/[-:.TZ]/g, "");
    const random = Math.random().toString(36).slice(2, 10);
    return `tgout-${chatId}-${timestamp}-${random}`;
  }

  private _getBackoffSeconds(attempts: number): number {
    if (attempts <= 1) return 30;
    if (attempts === 2) return 120;
    if (attempts === 3) return 600;
    if (attempts === 4) return 1800;
    return 7200;
  }

  private _safeWarn(message: string, context?: Record<string, unknown>): void {
    try {
      this._logger.warn(message, context);
    } catch {
      // Best-effort logging only.
    }
  }

  private _safeError(message: string, context?: Record<string, unknown>): void {
    try {
      this._logger.error(message, context);
    } catch {
      // Best-effort logging only.
    }
  }

  //#endregion Private methods
}
