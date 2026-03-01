import type { IScheduledTask } from "../shared/types/index.js";
import type { IRegisteredChannel } from "../shared/types/channel.types.js";

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
  /** @deprecated Use broadcastToNotificationChannelsAsync instead */
  sendToTelegramAsync: (message: string) => Promise<void>;
  /** Broadcast a message to all channels that have receiveNotifications=true */
  broadcastToNotificationChannelsAsync: (message: string) => Promise<void>;
  broadcastCronMessage: (taskName: string, message: string) => void;
  logInfo: (message: string, meta?: Record<string, unknown>) => void;
  executeTaskAsync: (
    task: IScheduledTask,
    sender: (msg: string) => Promise<string | null>,
  ) => Promise<ICronAgentResult>;
  openJobLogAsync: (key: string, path: string) => Promise<void>;
  closeJobLog: (key: string) => void;
  getJobLogPath: (taskName: string, timestamp: string) => string;
}

/**
 * Executes a cron task with proper message routing:
 *
 * - The `send_message` tool (toolMessageSender) broadcasts to ALL notification channels.
 *   When the agent explicitly calls send_message, the message goes through unconditionally.
 *
 * - The agent's final text output (result.text from the done tool summary)
 *   is forwarded to notification channels ONLY when `task.notifyUser` is true.
 *
 * - Logs and UI broadcast always happen regardless of notifyUser.
 */
export async function executeCronTaskAsync(
  task: IScheduledTask,
  deps: ICronTaskExecutorDeps,
): Promise<void> {
  // Sender for the send_message tool — broadcasts to all notification channels.
  // The agent explicitly chose to call send_message, so the message must go through.
  const toolMessageSender = async (message: string): Promise<string | null> => {
    deps.logInfo(`[Cron:${task.name}] ${message}`, { taskId: task.taskId });
    deps.broadcastCronMessage(task.name, message);
    await deps.broadcastToNotificationChannelsAsync(message);
    return null;
  };

  const safeTimestamp: string = new Date().toISOString().replace(/[:.]/g, "-");
  const jobLogPath: string = deps.getJobLogPath(task.name, safeTimestamp);
  const jobLogKey: string = task.taskId;

  await deps.openJobLogAsync(jobLogKey, jobLogPath);

  try {
    const result: ICronAgentResult = await deps.executeTaskAsync(task, toolMessageSender);

    // Forward the agent's final text output (done tool summary / model text).
    // This is separate from any send_message tool calls the agent made during execution.
    if (result.text) {
      deps.logInfo(`[Cron:${task.name}] Result: ${result.text}`, { taskId: task.taskId });
      deps.broadcastCronMessage(task.name, result.text);

      // Only forward the final text to notification channels when notifyUser is enabled.
      // send_message tool calls always go through regardless — this only gates
      // the automatic forwarding of the agent's summary/result text.
      if (task.notifyUser) {
        await deps.broadcastToNotificationChannelsAsync(result.text);
      }
    }
  } finally {
    deps.closeJobLog(jobLogKey);
  }
}

/**
 * Helper to get notification channels from the channel registry.
 * Re-exported for convenience.
 */
export type { IRegisteredChannel };
