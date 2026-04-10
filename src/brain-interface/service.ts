import { Server as SocketIOServer, type Socket } from "socket.io";

import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { MainAgent } from "../agent/main-agent.js";
import type {
  BrainCommand,
  BrainCommandResponse,
  BrainEvent,
  GraphUpdatedEvent,
} from "./types.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { StatusService, type IStatusState } from "../services/status.service.js";
import { verifyJwtToken } from "../utils/jwt.js";
import * as litesql from "../helpers/litesql.js";
import type { IQueryResult } from "../helpers/litesql.js";
import type { IQueryDatabaseCommand } from "./types.js";

export class BrainInterfaceService {
  private static _instance: BrainInterfaceService | null = null;
  private _io: SocketIOServer | null = null;
  private _logger: LoggerService;
  private _activeChats: Map<string, { paused: boolean }>;
  private _currentGraphs: Map<string, unknown>;
  private _logSubscribers: Set<Socket> = new Set<Socket>();
  private _jwtSecret: string | null = null;
  private _jwtIssuer: string | null = null;
  private _jwtAudience: string | null = null;

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._activeChats = new Map();
    this._currentGraphs = new Map();
  }

  public static getInstance(): BrainInterfaceService {
    if (!BrainInterfaceService._instance) {
      BrainInterfaceService._instance = new BrainInterfaceService();
    }

    return BrainInterfaceService._instance;
  }

  public initialize(io: SocketIOServer, jwtSecret: string, jwtIssuer: string, jwtAudience: string): void {
    this._io = io;
    this._jwtSecret = jwtSecret;
    this._jwtIssuer = jwtIssuer;
    this._jwtAudience = jwtAudience;
    this._logger.info("BrainInterfaceService initialized.");

    this._io.use((socket: Socket, next: (error?: Error) => void): void => {
      try {
        const token: unknown = socket.handshake.auth?.token;

        if (typeof token !== "string" || token.trim().length === 0) {
          next(new Error("Unauthorized: missing token"));
          return;
        }

        if (!this._jwtSecret || !this._jwtIssuer || !this._jwtAudience) {
          next(new Error("Unauthorized: auth not configured"));
          return;
        }

        verifyJwtToken(token, this._jwtSecret, this._jwtIssuer, this._jwtAudience);
        next();
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);
        this._logger.warn("BrainInterface authentication failed", {
          socketId: socket.id,
          error: errorMessage,
        });
        next(new Error("Unauthorized: invalid token"));
      }
    });

    LoggerService.getInstance().events.on("log", (logData: { level: string; message: string; context?: Record<string, unknown>; timestamp: string }) => {
      const event = { type: "log_entry", ...logData };
      for (const subscriber of this._logSubscribers) {
        if (subscriber.connected) {
          subscriber.emit("event", event);
        } else {
          this._logSubscribers.delete(subscriber);
        }
      }
    });

    // Broadcast status updates to all connected clients
    StatusService.getInstance().events.on("status_update", (statusData: { previous: IStatusState | null; current: IStatusState | null }) => {
      if (this._io) {
        this._io.emit("event", { type: "status_update", ...statusData });
      }
    });

    this._io.on("connection", (socket: Socket): void => {
      this._logger.info("BrainInterface client connected.", { socketId: socket.id });

      socket.on("command", async (command: BrainCommand, ack: (response: BrainCommandResponse) => void): Promise<void> => {
        await this._handleCommandAsync(socket, command, ack);
      });

      socket.on("disconnect", (): void => {
        this._logger.info("BrainInterface client disconnected.");
        this._logSubscribers.delete(socket);
      });
    });
  }

  public async emitStepStartedAsync(chatId: string, stepNumber: number): Promise<void> {
    this._emit({
      type: "step_started",
      data: { stepNumber, chatId },
    });
  }

  public async emitToolCalledAsync(
    chatId: string,
    stepNumber: number,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const reasoning: string | undefined =
      typeof input.reasoning === "string" && input.reasoning.trim().length > 0
        ? input.reasoning
        : undefined;

    this._emit({
      type: "tool_called",
      data: { stepNumber, chatId, toolName, input, reasoning },
    });
  }

  public async emitToolResultAsync(
    chatId: string,
    stepNumber: number,
    toolName: string,
    output: unknown,
    error?: string,
  ): Promise<void> {
    this._emit({
      type: "tool_result",
      data: { stepNumber, chatId, toolName, output, error },
    });
  }

  public async emitModelOutputAsync(chatId: string, stepNumber: number, text: string): Promise<void> {
    this._emit({
      type: "model_output",
      data: { stepNumber, chatId, text },
    });
  }

  public async emitGraphUpdatedAsync(chatId: string, graphData: GraphUpdatedEvent): Promise<void> {
    this._currentGraphs.set(chatId, graphData);

    this._emit({
      type: "graph_updated",
      data: graphData,
    });
  }

  public async emitConversationStartedAsync(chatId: string): Promise<void> {
    this._activeChats.set(chatId, { paused: false });

    this._emit({
      type: "conversation_started",
      data: { chatId },
    });
  }

  public async emitConversationEndedAsync(chatId: string, summary: string, stepsCount: number): Promise<void> {
    this._activeChats.delete(chatId);

    this._emit({
      type: "conversation_ended",
      data: { chatId, summary, stepsCount },
    });
  }

  public async emitErrorAsync(chatId: string, error: string): Promise<void> {
    this._emit({
      type: "error",
      data: { chatId, error },
    });
  }

  public async emitAgentPausedAsync(chatId: string): Promise<void> {
    this._emit({
      type: "agent_paused",
      data: { chatId },
    });
  }

  public async emitAgentResumedAsync(chatId: string): Promise<void> {
    this._emit({
      type: "agent_resumed",
      data: { chatId },
    });
  }

  public async emitAgentStoppedAsync(chatId: string): Promise<void> {
    this._emit({
      type: "agent_stopped",
      data: { chatId },
    });
  }

  public getCurrentGraph(chatId: string): unknown {
    return this._currentGraphs.get(chatId);
  }

  private _emit(event: BrainEvent): void {
    if (this._io) {
      this._io.emit("event", event);
    }
  }

  public broadcastCronMessage(taskName: string, message: string): void {
    this._emit({
      type: "cron_message",
      taskName,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private async _handleCommandAsync(_socket: Socket, command: BrainCommand, ack: (response: BrainCommandResponse) => void): Promise<void> {
    let response: BrainCommandResponse = { success: false };

    try {
      switch (command.type) {
        case "start_conversation": {
          if (!command.chatId) {
            response.error = "chatId is required";
            break;
          }

          const chatId: string = command.chatId;
          const mainAgent: MainAgent = MainAgent.getInstance();

          await mainAgent.initializeForChatAsync(
            chatId,
            async (_message: string): Promise<string | null> => null,
            async (_photo: unknown): Promise<string | null> => null,
          );

          await this.emitConversationStartedAsync(chatId);
          response.success = true;
          response.data = { chatId };
          break;
        }

        case "send_message": {
          if (!command.chatId || !command.message) {
            response.error = "chatId and message are required";
            break;
          }

          const chatId: string = command.chatId;
          const message: string = command.message;
          const mainAgent: MainAgent = MainAgent.getInstance();

          if (!mainAgent.isInitializedForChat(chatId)) {
            this._logger.warn("Chat session missing on send_message, auto-initializing", { chatId });
            await mainAgent.initializeForChatAsync(
              chatId,
              async (_message: string): Promise<string | null> => null,
              async (_photo: unknown): Promise<string | null> => null,
            );
          }

          const result = await mainAgent.processMessageForChatAsync(chatId, message);

          response.success = true;
          response.data = { text: result.text, stepsCount: result.stepsCount };
          break;
        }

        case "get_graph": {
          if (!command.chatId) {
            response.error = "chatId is required";
            break;
          }

          const graph = this.getCurrentGraph(command.chatId);
          response.success = true;
          response.data = graph ?? null;
          break;
        }

        case "pause": {
          if (!command.chatId) {
            response.error = "chatId is required";
            break;
          }

          const success: boolean = MainAgent.getInstance().pauseChat(command.chatId);
          response.success = success;

          if (success) {
            await this.emitAgentPausedAsync(command.chatId);
          } else {
            response.error = "Chat is not active or already paused";
          }
          break;
        }

        case "resume": {
          if (!command.chatId) {
            response.error = "chatId is required";
            break;
          }

          const success: boolean = MainAgent.getInstance().resumeChat(command.chatId);
          response.success = success;

          if (success) {
            await this.emitAgentResumedAsync(command.chatId);
          } else {
            response.error = "Chat is not paused";
          }
          break;
        }

        case "stop": {
          if (!command.chatId) {
            response.error = "chatId is required";
            break;
          }

          const success: boolean = MainAgent.getInstance().stopChat(command.chatId);
          response.success = success;

          if (success) {
            await this.emitAgentStoppedAsync(command.chatId);
          } else {
            response.error = "No active operation to stop";
          }
          break;
        }

        case "steer": {
          if (!command.chatId || !command.message) {
            response.error = "chatId and message are required";
            break;
          }

          const success: boolean = MainAgent.getInstance().steerChat(command.chatId, command.message);
          response.success = success;

          if (!success) {
            response.error = "Could not queue steering message. Chat may not be active.";
          }
          break;
        }

        case "list_schedules":
          response.data = SchedulerService.getInstance().getAllTasks();
          response.success = true;
          break;

        case "toggle_schedule": {
          const toggled: boolean = await SchedulerService.getInstance().setTaskEnabledAsync(command.taskId, command.enabled);
          if (!toggled) throw new Error("Task not found");
          response.success = true;
          break;
        }

        case "subscribe_logs":
          this._logSubscribers.add(_socket);
          response.success = true;
          break;

        case "unsubscribe_logs":
          this._logSubscribers.delete(_socket);
          response.success = true;
          break;

        case "query_database": {
          const dbCommand: IQueryDatabaseCommand = command as IQueryDatabaseCommand;

          try {
            let result: unknown;

            switch (dbCommand.action) {
              case "list_databases": {
                const databases = await litesql.listDatabasesAsync();
                result = {
                  success: true,
                  action: "list_databases",
                  databases: databases.map((db) => ({
                    name: db.name,
                    tableCount: db.tableCount,
                    sizeBytes: db.sizeBytes,
                    createdAt: db.createdAt,
                  })),
                };
                break;
              }

              case "list_tables": {
                if (!dbCommand.databaseName) {
                  const allDbs = await litesql.listDatabasesAsync();
                  const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";
                  result = {
                    success: false,
                    action: "list_tables",
                    error: `databaseName is required. Available databases: ${available}`,
                  };
                  break;
                }

                const exists: boolean = await litesql.databaseExistsAsync(dbCommand.databaseName);
                if (!exists) {
                  const allDbs = await litesql.listDatabasesAsync();
                  const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";
                  result = {
                    success: false,
                    action: "list_tables",
                    error: `Database "${dbCommand.databaseName}" does not exist. Available databases: ${available}`,
                  };
                  break;
                }

                const tables: string[] = await litesql.listTablesAsync(dbCommand.databaseName);
                result = {
                  success: true,
                  action: "list_tables",
                  databaseName: dbCommand.databaseName,
                  tables,
                };
                break;
              }

              case "query_table": {
                if (!dbCommand.databaseName || !dbCommand.tableName) {
                  result = {
                    success: false,
                    action: "query_table",
                    error: "databaseName and tableName are required",
                  };
                  break;
                }

                const dbExists: boolean = await litesql.databaseExistsAsync(dbCommand.databaseName);
                if (!dbExists) {
                  result = {
                    success: false,
                    action: "query_table",
                    error: `Database "${dbCommand.databaseName}" does not exist`,
                  };
                  break;
                }

                const tableExists: boolean = await litesql.tableExistsAsync(dbCommand.databaseName, dbCommand.tableName);
                if (!tableExists) {
                  result = {
                    success: false,
                    action: "query_table",
                    error: `Table "${dbCommand.tableName}" does not exist`,
                  };
                  break;
                }

                const queryResult: IQueryResult = await litesql.queryTableAsync(
                  dbCommand.databaseName,
                  dbCommand.tableName,
                  {
                    where: dbCommand.where,
                    orderBy: dbCommand.orderBy,
                    limit: dbCommand.limit ?? 100,
                    columns: dbCommand.columns,
                  },
                );

                result = {
                  success: true,
                  action: "query_table",
                  databaseName: dbCommand.databaseName,
                  tableName: dbCommand.tableName,
                  rows: queryResult.rows,
                  totalCount: queryResult.totalCount,
                  returnedCount: queryResult.rows.length,
                };
                break;
              }

              case "show_schema": {
                if (!dbCommand.databaseName || !dbCommand.tableName) {
                  result = {
                    success: false,
                    action: "show_schema",
                    error: "databaseName and tableName are required",
                  };
                  break;
                }

                const dbExists: boolean = await litesql.databaseExistsAsync(dbCommand.databaseName);
                if (!dbExists) {
                  result = {
                    success: false,
                    action: "show_schema",
                    error: `Database "${dbCommand.databaseName}" does not exist`,
                  };
                  break;
                }

                const schema = await litesql.getTableSchemaAsync(dbCommand.databaseName, dbCommand.tableName);
                result = {
                  success: true,
                  action: "show_schema",
                  databaseName: dbCommand.databaseName,
                  tableName: dbCommand.tableName,
                  schema: {
                    name: schema.name,
                    columns: schema.columns,
                  },
                };
                break;
              }

              default:
                result = {
                  success: false,
                  action: dbCommand.action,
                  error: `Unknown action: ${dbCommand.action}`,
                };
            }

            response.success = true;
            response.data = result;
          } catch (err: unknown) {
            const errorMessage: string = extractErrorMessage(err);
            response.success = false;
            response.data = {
              success: false,
              action: dbCommand.action,
              error: errorMessage,
            };
          }
          break;
        }

        case "factory_reset": {
          const { factoryResetAsync } = await import("../services/factory-reset.service.js");
          const result = await factoryResetAsync();
          response.success = result.success;
          response.data = result;
          if (!result.success) {
            response.error = result.errors.join("; ");
          }
          break;
        }

        default:
          response.error = `Unknown command type: ${(command as BrainCommand).type}`;
      }
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      this._logger.error("BrainInterface command error", { command, error: errorMessage });
      response = { success: false, error: errorMessage };
      const chatId: string = "chatId" in command ? (command.chatId ?? "") : "";
      try {
        await this.emitErrorAsync(chatId, errorMessage);
      } catch {
        // Ignore
      }
    }

    ack(response);
  }

  //#endregion
}
