import { tool } from "ai";
import { finishJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IJob, INode } from "../shared/types/index.js";
import { validateGraph, IGraphValidationResult } from "../jobs/graph.js";

export const finishJobTool = tool({
  description: "Mark a job as ready for execution. Validates the graph structure first.",
  inputSchema: finishJobToolInputSchema,
  execute: async ({ jobId }: { jobId: string }): Promise<{ success: boolean; message: string; validationErrors: string[] }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();

      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return { success: false, message: `Job "${jobId}" not found.`, validationErrors: [] };
      }

      if (job.status !== "creating") {
        return { success: false, message: `Job is already in "${job.status}" status.`, validationErrors: [] };
      }

      const nodes: INode[] = await storageService.listNodesAsync(jobId);
      const validationResult: IGraphValidationResult = validateGraph(nodes, job.entrypointNodeId);

      if (!validationResult.valid) {
        return { success: false, message: "Job validation failed.", validationErrors: validationResult.errors };
      }

      await storageService.updateJobAsync(jobId, { status: "ready" });

      return { success: true, message: "Job is now ready for execution.", validationErrors: [] };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message, validationErrors: [] };
    }
  },
});
