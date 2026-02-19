import { tool } from "ai";
import { removeJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";

export const removeJobTool = tool({
  description: "Delete a job and all its nodes and test cases.",
  inputSchema: removeJobToolInputSchema,
  execute: async ({ jobId }: { jobId: string }): Promise<{ success: boolean; message: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      await storageService.deleteJobAsync(jobId);

      return { success: true, message: "Job removed successfully." };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
