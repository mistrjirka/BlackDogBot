import type { IScheduledTask, IExecutionContext } from "../shared/types/index.js";
import { generateId } from "../utils/id.js";

/**
 * Result returned by the cron agent after executing a task.
 */
export interface ICronAgentResult {
  text: string;
  stepsCount: number;
}

/**
 * Dependencies injected into the cron task executor.
 * This allows the executor to be tested with mocks.
 */
export interface ICronTaskExecutorDeps {
  /** Broadcast a message to all channels that have receiveNotifications=true */
  broadcastToNotificationChannelsAsync: (message: string) => Promise<void>;
  executeTaskAsync: (
    task: IScheduledTask,
    sender: (msg: string) => Promise<string | null>,
    taskIdProvider: () => string | null,
    context: IExecutionContext,
  ) => Promise<ICronAgentResult>;
}

/**
 * Executes a cron task with proper message routing:
 *
 * - The `send_message` tool (toolMessageSender) broadcasts to ALL notification channels.
 *   When the agent explicitly calls send_message, the message goes through unconditionally.
 *
 * - The agent's final text output (result.text from the model response)
 *   is forwarded to notification channels ONLY when `task.notifyUser` is true.
 *
 * - Logs and UI broadcast always happen regardless of notifyUser.
 */
export async function executeCronTaskAsync(
  task: IScheduledTask,
  deps: ICronTaskExecutorDeps,
): Promise<void> {
  const executionContext = {
    toolCallHistory: [],
    taskName: task.name,
    taskDescription: task.description,
    taskInstructions: task.instructions,
  } as IExecutionContext;
  const taskIdProvider = (): string | null => task.taskId;

  const toolMessageSender = async (message: string): Promise<string | null> => {
    await deps.broadcastToNotificationChannelsAsync(message);
    return generateId();
  };

  try {
    const result: ICronAgentResult = await deps.executeTaskAsync(task, toolMessageSender, taskIdProvider, executionContext);

    if (result.text && task.notifyUser) {
      await deps.broadcastToNotificationChannelsAsync(result.text);
    }
  } finally {
    // No-op - removed job logging dependencies
  }
}
