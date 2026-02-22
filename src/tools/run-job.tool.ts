import { tool } from "ai";
import { runJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { IJobExecutionResult, INodeProgressEvent, NodeExecutionStatus } from "../shared/types/index.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";

export type NodeProgressEmitter = (
  jobId: string,
  activeNodeId: string | undefined,
  nodeStatuses: Record<string, string>,
) => Promise<void>;

export function createRunJobTool(
  tracker: IJobActivityTracker,
  emitProgressAsync?: NodeProgressEmitter,
) {
  return tool({
    description:
      "Execute a job with the given input data. The job must be in 'ready' status. " +
      "On failure, failedNodeId and failedNodeName identify which node failed.",
    inputSchema: runJobToolInputSchema,
    execute: async ({ jobId, input }: { jobId: string; input: Record<string, unknown> }): Promise<IJobExecutionResult> => {
      const executorService: JobExecutorService = JobExecutorService.getInstance();
      const nodeStatuses: Record<string, string> = {};

      const onNodeProgressAsync = async (event: INodeProgressEvent): Promise<void> => {
        nodeStatuses[event.nodeId] = event.status as string;

        if (emitProgressAsync) {
          const activeNodeId: string | undefined =
            (event.status as NodeExecutionStatus) === "executing" ? event.nodeId : undefined;

          await emitProgressAsync(jobId, activeNodeId, { ...nodeStatuses });
        }
      };

      const result: IJobExecutionResult = await executorService.executeJobAsync(jobId, input, onNodeProgressAsync);

      if (result.success) {
        tracker.trackRanSuccessfully(jobId);
      }

      return result;
    },
  });
}
