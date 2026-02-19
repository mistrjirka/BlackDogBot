import { tool } from "ai";
import { getJobsToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IJob, JobStatus } from "../shared/types/index.js";

export const getJobsTool = tool({
  description: "List all jobs, optionally filtered by status.",
  inputSchema: getJobsToolInputSchema,
  execute: async ({ status }: { status?: "creating" | "ready" | "running" | "completed" | "failed" }): Promise<{ jobs: Array<{ jobId: string; name: string; description: string; status: string }> }> => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const jobs: IJob[] = await storageService.listJobsAsync(status as JobStatus | undefined);

    return {
      jobs: jobs.map((j: IJob) => ({
        jobId: j.jobId,
        name: j.name,
        description: j.description,
        status: j.status,
      })),
    };
  },
});
