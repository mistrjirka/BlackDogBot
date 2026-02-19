import { tool } from "ai";
import { runJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { IJobExecutionResult } from "../shared/types/index.js";

export const runJobTool = tool({
  description: "Execute a job with the given input data. The job must be in 'ready' status. On failure, failedNodeId and failedNodeName identify which node failed.",
  inputSchema: runJobToolInputSchema,
  execute: async ({ jobId, input }: { jobId: string; input: Record<string, unknown> }): Promise<IJobExecutionResult> => {
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    return executorService.executeJobAsync(jobId, input);
  },
});
