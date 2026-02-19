import { tool } from "ai";
import { runJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { IJobExecutionResult } from "../shared/types/index.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";

export function createRunJobTool(tracker: IJobActivityTracker) {
  return tool({
    description: "Execute a job with the given input data. The job must be in 'ready' status. On failure, failedNodeId and failedNodeName identify which node failed.",
    inputSchema: runJobToolInputSchema,
    execute: async ({ jobId, input }: { jobId: string; input: Record<string, unknown> }): Promise<IJobExecutionResult> => {
      const executorService: JobExecutorService = JobExecutorService.getInstance();
      const result: IJobExecutionResult = await executorService.executeJobAsync(jobId, input);

      if (result.success) {
        tracker.trackRanSuccessfully(jobId);
      }

      return result;
    },
  });
}
