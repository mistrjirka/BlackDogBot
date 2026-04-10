import type { INode } from "../shared/types/index.js";

export type BrainCommandType =
  | "start_conversation"
  | "send_message"
  | "pause"
  | "resume"
  | "stop"
  | "steer"
  | "get_graph"
  | "list_schedules"
  | "toggle_schedule"
  | "subscribe_logs"
  | "unsubscribe_logs"
  | "query_database"
  | "factory_reset";

export interface IBrainCommand {
  type: string;
}

export interface IToggleScheduleCommand extends IBrainCommand {
  type: "toggle_schedule";
  taskId: string;
  enabled: boolean;
}

export interface IQueryDatabaseCommand extends IBrainCommand {
  type: "query_database";
  action: "list_databases" | "list_tables" | "query_table" | "show_schema";
  databaseName?: string;
  tableName?: string;
  where?: string;
  orderBy?: string;
  limit?: number;
  columns?: string[];
}

export type BrainCommand =
  | { type: "start_conversation"; chatId: string }
  | { type: "send_message"; chatId: string; message: string }
  | { type: "pause"; chatId: string }
  | { type: "resume"; chatId: string }
  | { type: "stop"; chatId: string }
  | { type: "steer"; chatId: string; message: string }
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
  | "cron_message";

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

export interface StepStartedEvent {
  stepNumber: number;
  chatId: string;
}

export interface ToolCalledEvent {
  stepNumber: number;
  chatId: string;
  toolName: string;
  input: Record<string, unknown>;
  reasoning?: string;
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

export interface ICronMessageEvent extends IBrainEvent {
  type: "cron_message";
  taskName: string;
  message: string;
  timestamp: string;
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
  | ICronMessageEvent;

export interface IBrainInterfaceEmitter {
  emitStepStartedAsync(chatId: string, stepNumber: number): Promise<void>;
  emitToolCalledAsync(chatId: string, stepNumber: number, toolName: string, input: Record<string, unknown>): Promise<void>;
  emitToolResultAsync(chatId: string, stepNumber: number, toolName: string, output: unknown, error?: string): Promise<void>;
  emitModelOutputAsync(chatId: string, stepNumber: number, text: string): Promise<void>;
}
