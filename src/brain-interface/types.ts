import type { INode, IJob } from "../shared/types/index.js";
import type { INodeTestCase, INodeTestResult } from "../shared/types/job.types.js";

export type BrainCommandType =
  | "start_conversation"
  | "send_message"
  | "pause"
  | "resume"
  | "stop"
  | "get_graph"
  | "list_jobs"
  | "load_job"
  | "run_job"
  | "list_schedules"
  | "toggle_schedule"
  | "subscribe_logs"
  | "unsubscribe_logs"
  | "get_node_tests"
  | "run_node_test"
  | "query_database"
  | "factory_reset";

export interface IBrainCommand {
  type: string;
}

export interface IRunJobCommand extends IBrainCommand {
  type: "run_job";
  jobId: string;
}

export interface IToggleScheduleCommand extends IBrainCommand {
  type: "toggle_schedule";
  taskId: string;
  enabled: boolean;
}

export interface IGetNodeTestsCommand extends IBrainCommand {
  type: "get_node_tests";
  jobId: string;
  nodeId?: string;
}

export interface IRunNodeTestCommand extends IBrainCommand {
  type: "run_node_test";
  testId: string;
  jobId: string;
  nodeId: string;
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
  | {
      type: Exclude<BrainCommandType, "run_job" | "toggle_schedule" | "get_node_tests" | "run_node_test" | "query_database" | "factory_reset">;
      chatId?: string;
      message?: string;
      jobId?: string;
    }
  | IRunJobCommand
  | IToggleScheduleCommand
  | IGetNodeTestsCommand
  | IRunNodeTestCommand
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
  | "job_execution_started"
  | "job_execution_completed"
  | "job_execution_failed"
  | "log_entry"
  | "cron_message";

export interface IBrainEvent {
  type: string;
}

export interface IJobExecutionStartedEvent extends IBrainEvent {
  type: "job_execution_started";
  jobId: string;
  startedAt: number;
}

export interface IJobExecutionCompletedEvent extends IBrainEvent {
  type: "job_execution_completed";
  jobId: string;
  result: Record<string, unknown>;
  timing: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
  nodesExecuted: number;
  nodeResults: {
    nodeId: string;
    nodeName: string;
    duration: number;
  }[];
}

export interface IJobExecutionFailedEvent extends IBrainEvent {
  type: "job_execution_failed";
  jobId: string;
  error: string;
  timing?: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
  nodesExecuted: number;
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
  | IJobExecutionStartedEvent
  | IJobExecutionCompletedEvent
  | IJobExecutionFailedEvent
  | ILogEntryEvent
  | ICronMessageEvent;

export interface StoredJobInfo {
  jobId: string;
  name: string;
  description: string;
  status: string;
  entrypointNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export interface FullJobData {
  job: IJob;
  nodes: INode[];
}

// Re-export test types for frontend convenience
export type { INodeTestCase, INodeTestResult };
