import { tool } from "ai";
import { runJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobExecutorService } from "../services/job-executor.service.js";

export const runJobTool = tool({
  description: "Execute a job with the given input data. The job must be in 'ready' status.",
  inputSchema: runJobToolInputSchema,
  execute: async ({ jobId, input }: { jobId: string; input: Record<string, unknown> }): Promise<{ success: boolean; output: unknown; error: string | null; nodesExecuted: number }> => {
    const executorService: JobExecutorService = JobExecutorService.getInstance();

    return executorService.executeJobAsync(jobId, input);
  },
});
