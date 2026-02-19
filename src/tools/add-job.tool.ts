import { tool } from "ai";
import { addJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IJob } from "../shared/types/index.js";

export const addJobTool = tool({
  description: "Create a new job. Jobs are structured task graphs with input/output validated nodes.",
  inputSchema: addJobToolInputSchema,
  execute: async ({ name, description }: { name: string; description: string }): Promise<{ jobId: string; status: string }> => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const job: IJob = await storageService.createJobAsync(name, description);

    return { jobId: job.jobId, status: job.status };
  },
});
