export type BrainEventType =
  | "step_started"
  | "tool_called"
  | "tool_result"
  | "model_output"
  | "graph_updated"
  | "conversation_started"
  | "conversation_ended"
  | "agent_paused"
  | "agent_resumed"
  | "agent_stopped"
  | "error"
  | "log_entry"
  | "status_update"
  | "user_message"
  | "cron_message";

export type BrainCommandType =
  | "start_conversation"
  | "send_message"
  | "pause"
  | "resume"
  | "stop"
  | "get_graph"
  | "list_schedules"
  | "toggle_schedule"
  | "subscribe_logs"
  | "unsubscribe_logs"
  | "query_database"
  | "factory_reset";

export interface IBrainEvent {
  type: string;
}

export interface ILogEntryEvent extends IBrainEvent {
  type: "log_entry";
  level: string;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface IStatusUpdateEvent extends IBrainEvent {
  type: "status_update";
  previous: IStatusState | null;
  current: IStatusState | null;
}

export interface StepStartedEvent {
  stepNumber: number;
  chatId: string;
}

export interface ToolCalledEvent {
  stepNumber: number;
  chatId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  stepNumber: number;
  chatId: string;
  toolName: string;
  output: unknown;
  error?: string;
}

export interface ModelOutputEvent {
  stepNumber: number;
  chatId: string;
  text: string;
}

export type NodeType =
  | "start"
  | "curl_fetcher"
  | "crawl4ai"
  | "searxng"
  | "rss_fetcher"
  | "python_code"
  | "output_to_ai"
  | "agent"
  | "litesql";

export interface INode {
  nodeId: string;
  jobId: string;
  type: NodeType;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  connections: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphUpdatedEvent {
  chatId: string;
  jobId: string;
  jobName: string;
  nodes: INode[];
  entrypointNodeId: string | null;
  activeNodeId?: string;
  nodeStatuses?: Record<string, string>;
}

export interface ConversationStartedEvent {
  chatId: string;
}

export interface ConversationEndedEvent {
  chatId: string;
  summary: string;
  stepsCount: number;
}

export interface ErrorEvent {
  chatId: string;
  error: string;
}

export interface AgentPausedEvent {
  chatId: string;
}

export interface AgentResumedEvent {
  chatId: string;
}

export interface AgentStoppedEvent {
  chatId: string;
}

export interface ICronMessageEvent extends IBrainEvent {
  type: "cron_message";
  taskName: string;
  message: string;
  timestamp: string;
}

export type BrainEvent =
  | { type: "step_started"; data: StepStartedEvent }
  | { type: "tool_called"; data: ToolCalledEvent }
  | { type: "tool_result"; data: ToolResultEvent }
  | { type: "model_output"; data: ModelOutputEvent }
  | { type: "graph_updated"; data: GraphUpdatedEvent }
  | { type: "conversation_started"; data: ConversationStartedEvent }
  | { type: "conversation_ended"; data: ConversationEndedEvent }
  | { type: "agent_paused"; data: AgentPausedEvent }
  | { type: "agent_resumed"; data: AgentResumedEvent }
  | { type: "agent_stopped"; data: AgentStoppedEvent }
  | { type: "error"; data: ErrorEvent }
  | ILogEntryEvent
  | IStatusUpdateEvent
  | ICronMessageEvent;

export interface IBrainCommand {
  type: string;
}

export interface IToggleScheduleCommand extends IBrainCommand {
  type: "toggle_schedule";
  taskId: string;
  enabled: boolean;
}

//#region Database Types

export type DatabaseQueryAction = "list_databases" | "list_tables" | "query_table" | "show_schema";

export interface IQueryDatabaseCommand extends IBrainCommand {
  type: "query_database";
  action: DatabaseQueryAction;
  databaseName?: string;
  tableName?: string;
  where?: string;
  orderBy?: string;
  limit?: number;
  columns?: string[];
}

export interface IDatabaseInfo {
  name: string;
  tableCount: number;
  sizeBytes: number;
  createdAt: string;
}

export interface ITableColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface ITableSchema {
  name: string;
  columns: ITableColumnInfo[];
}

export interface IQueryDatabaseResult {
  success: boolean;
  action: DatabaseQueryAction;
  databases?: IDatabaseInfo[];
  databaseName?: string;
  tables?: string[];
  tableName?: string;
  rows?: Record<string, unknown>[];
  totalCount?: number;
  returnedCount?: number;
  schema?: ITableSchema;
  error?: string;
}

//#endregion Database Types

//#region Status Types

export type StatusType =
  | "idle"
  | "llm_request"
  | "embedding"
  | "job_execution"
  | "skill_setup"
  | "tool_execution"
  | "web_search"
  | "web_crawl"
  | "http_request";

export interface IStatusState {
  type: StatusType;
  message: string;
  details: Record<string, unknown>;
  startedAt: number;
  inputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;      // Full context window from model
  compactionThreshold?: number; // 75% of context window
  contextPercentage?: number;
}

//#endregion Status Types

export type BrainCommand =
  | { type: "start_conversation"; chatId: string }
  | { type: "send_message"; chatId: string; message: string }
  | { type: "pause"; chatId: string }
  | { type: "resume"; chatId: string }
  | { type: "stop"; chatId: string }
  | { type: "get_graph"; chatId: string }
  | { type: "list_schedules" }
  | IToggleScheduleCommand
  | { type: "subscribe_logs" }
  | { type: "unsubscribe_logs" }
  | IQueryDatabaseCommand
  | { type: "factory_reset" };

export interface BrainCommandResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface IScheduleOnce {
  type: "once";
  runAt: string;
  offsetFromDayStart: {
    hours: number;
    minutes: number;
  };
  timezone: string;
}

export interface IScheduleInterval {
  type: "interval";
  every: {
    hours: number;
    minutes: number;
  };
  offsetFromDayStart: {
    hours: number;
    minutes: number;
  };
  timezone: string;
}

export interface IScheduleCron {
  type: "cron";
  expression: string;
}

export type Schedule = IScheduleOnce | IScheduleInterval | IScheduleCron;

export interface IScheduleTask {
  taskId: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  schedule: Schedule;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failure" | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserMessageEntry {
  id: string;
  timestamp: Date;
  type: "user_message";
  data: { message: string };
}

export type TerminalEntry =
  | (Exclude<BrainEvent, ILogEntryEvent> & { id: string; timestamp: Date })
  | UserMessageEntry;
