import { Server as SocketIOServer, type Socket } from "socket.io";

import { LoggerService } from "../services/logger.service.js";
import { MainAgent } from "../agent/main-agent.js";
import type {
  BrainCommand,
  BrainCommandResponse,
  BrainEvent,
  GraphUpdatedEvent,
  StoredJobInfo,
  FullJobData,
} from "./types.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { StatusService, type IStatusState } from "../services/status.service.js";
import { extractErrorMessage } from "../utils/error.js";
import * as litesql from "../helpers/litesql.js";
import type { IQueryResult } from "../helpers/litesql.js";
import type { IJob, INode } from "../shared/types/index.js";
import type { INodeProgressEvent, INodeTestCase, INodeTestResult } from "../shared/types/job.types.js";
import type { IQueryDatabaseCommand } from "./types.js";

export class BrainInterfaceService {
  private static _instance: BrainInterfaceService | null = null;
  private _io: SocketIOServer | null = null;
  private _logger: LoggerService;
  private _activeChats: Map<string, { paused: boolean }>;
  private _currentGraphs: Map<string, { jobId: string; nodes: INode[]; entrypointNodeId: string | null }>;
  private _logSubscribers: Set<Socket> = new Set<Socket>();

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

  public initialize(io: SocketIOServer): void {
    this._io = io;
    this._logger.info("BrainInterfaceService initialized.");

    JobStorageService.getInstance().events.on("graph_changed", async ({ jobId }) => {
      // We need to broadcast this graph update to all active chats that might be looking at it.
      for (const chatId of this._activeChats.keys()) {
        try {
          const storage = JobStorageService.getInstance();
          const job = await storage.getJobAsync(jobId);
          if (job) {
            const nodes = await storage.listNodesAsync(jobId);
            await this.emitGraphUpdatedAsync(chatId, {
              chatId,
              jobId,
              jobName: job.name,
              nodes,
              entrypointNodeId: job.entrypointNodeId,
            });
          }
        } catch (err) {
          // Ignore errors if the chat disconnected or job doesn't exist
        }
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
    this._emit({
      type: "tool_called",
      data: { stepNumber, chatId, toolName, input },
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
    this._currentGraphs.set(chatId, {
      jobId: graphData.jobId,
      nodes: graphData.nodes,
      entrypointNodeId: graphData.entrypointNodeId,
    });

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

  public getCurrentGraph(chatId: string): { jobId: string; nodes: INode[]; entrypointNodeId: string | null } | undefined {
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

        case "list_jobs": {
          const storage: JobStorageService = JobStorageService.getInstance();
          const jobs: IJob[] = await storage.listJobsAsync();

          const jobInfos: StoredJobInfo[] = await Promise.all(
            jobs.map(async (job: IJob): Promise<StoredJobInfo> => {
              const nodes: INode[] = await storage.listNodesAsync(job.jobId);

              return {
                jobId: job.jobId,
                name: job.name,
                description: job.description,
                status: job.status,
                entrypointNodeId: job.entrypointNodeId,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                nodeCount: nodes.length,
              };
            }),
          );

          response.success = true;
          response.data = jobInfos;
          break;
        }

        case "load_job": {
          if (!command.jobId) {
            response.error = "jobId is required";
            break;
          }

          const storage: JobStorageService = JobStorageService.getInstance();
          const job: IJob | null = await storage.getJobAsync(command.jobId);

          if (!job) {
            response.error = "Job not found";
            break;
          }

          const nodes: INode[] = await storage.listNodesAsync(command.jobId);

          await this.emitGraphUpdatedAsync("", {
            chatId: "",
            jobId: job.jobId,
            jobName: job.name,
            nodes,
            entrypointNodeId: job.entrypointNodeId,
          });

          response.success = true;
          response.data = { job, nodes } as FullJobData;
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

        case "run_job":
          if (!command.jobId) {
            throw new Error("jobId is required for run_job command");
          }
          await this._handleRunJobAsync(_socket, command.jobId);
          response.success = true;
          break;

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

        case "get_node_tests": {
          if (!command.jobId) {
            response.error = "jobId is required";
            break;
          }

          const storage: JobStorageService = JobStorageService.getInstance();
          
          // If nodeId is provided, get tests for that specific node
          // Otherwise, get all nodes and their tests
          let tests: INodeTestCase[];
          
          if (command.nodeId) {
            tests = await storage.getTestCasesAsync(command.jobId, command.nodeId);
          } else {
            // Get all nodes for the job and collect all tests
            const nodes: INode[] = await storage.listNodesAsync(command.jobId);
            const allTests: INodeTestCase[][] = await Promise.all(
              nodes.map((n: INode) => storage.getTestCasesAsync(command.jobId, n.nodeId)),
            );
            tests = allTests.flat();
          }

          response.success = true;
          response.data = tests;
          break;
        }

        case "run_node_test": {
          if (!command.testId) {
            response.error = "testId is required";
            break;
          }

          if (!command.jobId || !command.nodeId) {
            response.error = "jobId and nodeId are required";
            break;
          }

          const executor: JobExecutorService = JobExecutorService.getInstance();

          try {
            // Run all tests for the node and find the specific one
            const { results } = await executor.runNodeTestsAsync(command.jobId, command.nodeId);
            const result: INodeTestResult | undefined = results.find(
              (r: INodeTestResult) => r.testId === command.testId,
            );

            if (!result) {
              response.error = "Test not found";
              break;
            }

            response.success = true;
            response.data = result;
          } catch (err: unknown) {
            const errorMessage: string = err instanceof Error ? err.message : String(err);
            response.error = errorMessage;
          }
          break;
        }

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
            const errorMessage: string = err instanceof Error ? err.message : String(err);
            response.success = true;
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

  private async _handleRunJobAsync(_socket: Socket, jobId: string): Promise<void> {
    const storage: JobStorageService = JobStorageService.getInstance();
    const nodeStatuses: Record<string, string> = {};
    const startedAt: number = Date.now();

    this._emit({ type: "job_execution_started", jobId, startedAt });

    try {
      const result = await JobExecutorService.getInstance().executeJobAsync(
        jobId,
        {},
        async (progress: INodeProgressEvent): Promise<void> => {
          nodeStatuses[progress.nodeId] = progress.status;

          const job: IJob | null = await storage.getJobAsync(jobId);
          const nodes: INode[] = await storage.listNodesAsync(jobId);

          if (job) {
            await this.emitGraphUpdatedAsync("", {
              chatId: "",
              jobId: job.jobId,
              jobName: job.name,
              nodes,
              entrypointNodeId: job.entrypointNodeId,
              activeNodeId: progress.nodeId,
              nodeStatuses: { ...nodeStatuses },
            });
          }
        },
      );

      this._emit({ 
        type: "job_execution_completed", 
        jobId, 
        result: (result.output ?? {}) as Record<string, unknown>,
        timing: {
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        },
        nodesExecuted: result.nodesExecuted,
        nodeResults: result.nodeResults ?? [],
      });
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error ? err.message : String(err);
      this._emit({ 
        type: "job_execution_failed", 
        jobId, 
        error: errorMessage,
        timing: {
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        },
        nodesExecuted: Object.keys(nodeStatuses).length,
      });
    }
  }
}
