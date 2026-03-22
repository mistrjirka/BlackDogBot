import { Injectable, signal, OnDestroy, inject } from "@angular/core";
import { io, Socket } from "socket.io-client";
import { ChangeDetectorRef } from "@angular/core";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
import type {
  BrainEvent,
  BrainCommand,
  BrainCommandResponse,
  TerminalEntry,
  UserMessageEntry,
  GraphUpdatedEvent,
  StoredJobInfo,
  FullJobData,
  IScheduleTask,
  IToggleScheduleCommand,
  ILogEntryEvent,
  INodeTestCase,
  INodeTestResult,
  IStatusState,
  IQueryDatabaseCommand,
  IQueryDatabaseResult,
} from "../models/brain.types";

@Injectable({
  providedIn: "root",
})
export class BrainSocketService implements OnDestroy {
  private static readonly _AuthTokenStorageKey: string = "blackdogbot_brain_jwt";
  private _socket: Socket | null = null;
  private _connected = signal(false);
  private _events = signal<TerminalEntry[]>([]);
  private _graph = signal<GraphUpdatedEvent | null>(null);
  private _currentChatId = signal<string | null>(localStorage.getItem("blackdogbot_chat_id") || null);
  private _jobs = signal<StoredJobInfo[]>([]);
  private _lastJobId = signal<string | null>(null);
  private _isExecuting = signal<boolean>(false);
  private _logs = signal<ILogEntryEvent[]>([]);
  private _status = signal<IStatusState | null>(null);
  private _authError = signal<string | null>(null);
  private _connectPromise: Promise<void> | null = null;
  private _connectResolve: (() => void) | null = null;

  public onConnectedAsync(): Promise<void> {
    if (this._connected()) return Promise.resolve();
    if (!this._connectPromise) {
      this._connectPromise = new Promise<void>((resolve) => {
        this._connectResolve = resolve;
      });
    }
    return this._connectPromise;
  }

  public readonly connected = this._connected.asReadonly();
  public readonly events = this._events.asReadonly();
  public readonly graph = this._graph.asReadonly();
  public readonly currentChatId = this._currentChatId.asReadonly();
  public readonly jobs = this._jobs.asReadonly();
  public readonly lastJobId = this._lastJobId.asReadonly();
  public readonly isExecuting = this._isExecuting.asReadonly();
  public readonly logs = this._logs.asReadonly();
  public readonly status = this._status.asReadonly();
  public readonly authError = this._authError.asReadonly();

  public getAuthToken(): string {
    return localStorage.getItem(BrainSocketService._AuthTokenStorageKey) ?? "";
  }

  public setAuthToken(token: string): void {
    const trimmedToken: string = token.trim();

    if (trimmedToken.length > 0) {
      localStorage.setItem(BrainSocketService._AuthTokenStorageKey, trimmedToken);
    } else {
      localStorage.removeItem(BrainSocketService._AuthTokenStorageKey);
    }
  }

  public connect(url: string = "http://localhost:3001", token?: string): void {
    if (this._socket) {
      this._socket.disconnect();
    }

    const resolvedToken: string = (token ?? this.getAuthToken()).trim();

    this._authError.set(null);

    this._socket = io(url, {
      transports: ["websocket"],
      auth: {
        token: resolvedToken,
      },
    });

    this._socket.on("connect", async (): Promise<void> => {
      this._connected.set(true);
      if (this._connectResolve) {
        this._connectResolve();
        this._connectResolve = null;
      }

      // Reload job list on every (re)connect
      const freshJobs: StoredJobInfo[] = await this._fetchJobsAsync();
      this._jobs.set(freshJobs);

      // Restore graph for the last selected job after a reload / reconnect
      const lastId: string | null = this._lastJobId();

      if (lastId) {
        await this._loadAndSetGraphAsync(lastId);
      }
    });

    this._socket.on("disconnect", (): void => {
      this._connected.set(false);
      this._connectPromise = null;
      this._connectResolve = null;
    });

    this._socket.on("connect_error", (error: Error): void => {
      this._connected.set(false);
      this._authError.set(error.message);
    });

    this._socket.on("event", (event: BrainEvent): void => {
      this._handleEvent(event);
    });
  }

  public disconnect(): void {
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
      this._connected.set(false);
    }
  }

  public async sendCommandAsync(command: BrainCommand): Promise<BrainCommandResponse> {
    return new Promise((resolve): void => {
      if (!this._socket) {
        resolve({ success: false, error: "Not connected" });
        return;
      }

      this._socket.emit("command", command, (response: BrainCommandResponse): void => {
        resolve(response);
      });
    });
  }

  public async startConversationAsync(chatId: string): Promise<BrainCommandResponse> {
    this._currentChatId.set(chatId);
    localStorage.setItem("blackdogbot_chat_id", chatId);
    return this.sendCommandAsync({ type: "start_conversation", chatId });
  }

  public addUserMessage(message: string): void {
    const entry: UserMessageEntry = {
      type: "user_message",
      id: generateId(),
      timestamp: new Date(),
      data: { message },
    };
    this._events.update((events: TerminalEntry[]) => [...events, entry]);
  }

  public async sendMessageAsync(message: string): Promise<BrainCommandResponse> {
    const chatId: string | null = this._currentChatId();

    if (!chatId) {
      return { success: false, error: "No active conversation" };
    }

    return this.sendCommandAsync({ type: "send_message", chatId, message });
  }

  public async listJobsAsync(): Promise<StoredJobInfo[]> {
    const fresh: StoredJobInfo[] = await this._fetchJobsAsync();
    this._jobs.set(fresh);
    return fresh;
  }

  public async loadJobAsync(jobId: string): Promise<BrainCommandResponse> {
    this._lastJobId.set(jobId);
    return this._loadAndSetGraphAsync(jobId);
  }

  public async runJobAsync(jobId: string): Promise<void> {
    await this.sendCommandAsync({ type: "run_job", jobId });
  }

  public async pauseAsync(): Promise<BrainCommandResponse> {
    const chatId: string | null = this._currentChatId();

    if (!chatId) {
      return { success: false, error: "No active conversation" };
    }

    return this.sendCommandAsync({ type: "pause", chatId });
  }

  public async resumeAsync(): Promise<BrainCommandResponse> {
    const chatId: string | null = this._currentChatId();

    if (!chatId) {
      return { success: false, error: "No active conversation" };
    }

    return this.sendCommandAsync({ type: "resume", chatId });
  }

  public async stopAsync(): Promise<BrainCommandResponse> {
    const chatId: string | null = this._currentChatId();

    if (!chatId) {
      return { success: false, error: "No active conversation" };
    }

    return this.sendCommandAsync({ type: "stop", chatId });
  }

  public async listSchedulesAsync(): Promise<IScheduleTask[]> {
    const res: BrainCommandResponse = await this.sendCommandAsync({ type: "list_schedules" });
    return (res.data as IScheduleTask[]) || [];
  }

  public async toggleScheduleAsync(taskId: string, enabled: boolean): Promise<void> {
    await this.sendCommandAsync({ type: "toggle_schedule", taskId, enabled } as IToggleScheduleCommand);
  }

  public async subscribeLogsAsync(): Promise<void> {
    await this.sendCommandAsync({ type: "subscribe_logs" });
  }

  public async unsubscribeLogsAsync(): Promise<void> {
    await this.sendCommandAsync({ type: "unsubscribe_logs" });
  }

  public async getNodeTestsAsync(jobId: string, nodeId?: string): Promise<INodeTestCase[]> {
    const res: BrainCommandResponse = await this.sendCommandAsync({
      type: "get_node_tests",
      jobId,
      nodeId,
    });

    return (res.data as INodeTestCase[]) ?? [];
  }

  public async runNodeTestAsync(
    testId: string,
    jobId: string,
    nodeId: string,
  ): Promise<INodeTestResult | null> {
    const res: BrainCommandResponse = await this.sendCommandAsync({
      type: "run_node_test",
      testId,
      jobId,
      nodeId,
    });

    return res.success ? (res.data as INodeTestResult) : null;
  }

  public async queryDatabaseAsync(
    action: IQueryDatabaseCommand["action"],
    databaseName?: string,
    tableName?: string,
    options?: {
      where?: string;
      orderBy?: string;
      limit?: number;
      columns?: string[];
    },
  ): Promise<IQueryDatabaseResult> {
    const command: IQueryDatabaseCommand = {
      type: "query_database",
      action,
      databaseName,
      tableName,
      ...options,
    };

    const res: BrainCommandResponse = await this.sendCommandAsync(command);

    if (res.success && res.data) {
      return res.data as IQueryDatabaseResult;
    }

    return {
      success: false,
      action,
      error: res.error ?? "Unknown error",
    };
  }

  public clearEvents(): void {
    this._events.set([]);
  }

  public async factoryResetAsync(): Promise<BrainCommandResponse> {
    const res: BrainCommandResponse = await this.sendCommandAsync({ type: "factory_reset" });

    // Clear local state regardless of result
    const newId: string = generateId();
    localStorage.setItem("blackdogbot_chat_id", newId);
    this._currentChatId.set(newId);
    this._events.set([]);
    this._graph.set(null);
    this._jobs.set([]);
    this._lastJobId.set(null);

    // Start a fresh conversation
    await this.sendCommandAsync({ type: "start_conversation", chatId: newId });

    return res;
  }

  public ngOnDestroy(): void {
    this.disconnect();
  }

  //#region Private methods

  private async _fetchJobsAsync(): Promise<StoredJobInfo[]> {
    const response: BrainCommandResponse = await this.sendCommandAsync({ type: "list_jobs" });
    return (response.data as StoredJobInfo[]) ?? [];
  }

  private async _loadAndSetGraphAsync(jobId: string): Promise<BrainCommandResponse> {
    const response: BrainCommandResponse = await this.sendCommandAsync({ type: "load_job", jobId });

    if (response.success && response.data) {
      const { job, nodes } = response.data as FullJobData;

      this._graph.set({
        chatId: "",
        jobId: job.jobId,
        jobName: job.name,
        nodes,
        entrypointNodeId: job.entrypointNodeId,
      });
    }

    return response;
  }

  private _handleEvent(event: BrainEvent): void {
    console.log("[BrainSocket] Received event:", event.type);
    
    if (event.type === "log_entry") {
      this._logs.update((logs: ILogEntryEvent[]): ILogEntryEvent[] => {
        const newLogs: ILogEntryEvent[] = [...logs, event];
        if (newLogs.length > 1000) newLogs.shift();
        return newLogs;
      });
      return;
    }

    if (event.type === "status_update") {
      this._status.set(event.current);
      return;
    }

    if (event.type === "cron_message") {
      const entry: TerminalEntry = {
        type: "user_message",
        id: generateId(),
        timestamp: new Date(event.timestamp),
        data: { message: `[CRON:${event.taskName}] ${event.message}` },
      };
      this._events.update((events: TerminalEntry[]): TerminalEntry[] => [...events, entry]);
      return;
    }

    const entry: TerminalEntry = {
      ...event,
      id: generateId(),
      timestamp: new Date(),
    };

    this._events.update((events: TerminalEntry[]): TerminalEntry[] => [...events, entry]);

    if (event.type === "graph_updated") {
      this._graph.set(event.data);
      this._lastJobId.set(event.data.jobId);
    }

    if (event.type === "conversation_started") {
      this._currentChatId.set(event.data.chatId);
      localStorage.setItem("blackdogbot_chat_id", event.data.chatId);
    }

    if (event.type === "conversation_ended") {
      // Intentionally do not clear the chat ID here to allow multi-message sessions
    }

    if (event.type === "agent_stopped") {
      // Intentionally do not clear the chat ID to allow resuming or sending new messages
    }

    if (event.type === "job_execution_started") {
      this._isExecuting.set(true);
      console.log(`[BrainSocket] Job execution started: ${event.jobId} at ${new Date(event.startedAt).toISOString()}`);
    }

    if (event.type === "job_execution_completed") {
      this._isExecuting.set(false);
      const duration = event.timing?.durationMs ?? 0;
      const nodesCount = event.nodesExecuted ?? 0;
      console.log(
        `[BrainSocket] Job execution completed: ${event.jobId}`,
        `Duration: ${duration}ms, Nodes: ${nodesCount}`,
        event.result
      );
    }

    if (event.type === "job_execution_failed") {
      this._isExecuting.set(false);
      const duration = event.timing?.durationMs ?? 0;
      const nodesCount = event.nodesExecuted ?? 0;
      console.error(
        `[BrainSocket] Job execution failed: ${event.jobId}`,
        `After ${duration}ms, ${nodesCount} nodes executed`,
        event.error
      );
    }
  }

  //#endregion Private methods
}
