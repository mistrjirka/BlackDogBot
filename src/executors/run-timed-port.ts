import type { IAgentResult } from "../agent/base-agent.js";
import type {
  IExecutionContext,
  IScheduledTask,
  ITraceCollector,
} from "../shared/types/index.js";
import type {
  MessageSender,
  TaskIdProvider,
} from "../tools/knowledge-tool-factory.js";

export type RunTimedTaskExecutor = (
  task: IScheduledTask,
  sender: MessageSender,
  taskIdProvider: TaskIdProvider,
  executionContext: IExecutionContext,
  traceCollector?: ITraceCollector,
) => Promise<IAgentResult>;

let runTimedExecutor: RunTimedTaskExecutor | null = null;

export function registerRunTimedExecutor(executor: RunTimedTaskExecutor): void {
  runTimedExecutor = executor;
}

export function getRunTimedExecutor(): RunTimedTaskExecutor {
  if (!runTimedExecutor) {
    throw new Error("Run-timed task executor has not been registered");
  }
  return runTimedExecutor;
}
