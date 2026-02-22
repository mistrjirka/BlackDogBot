import { tool } from "ai";
import { removeJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { type IJobCreationModeTracker } from "../utils/job-creation-mode-tracker.js";

export function createRemoveJobTool(creationModeTracker: IJobCreationModeTracker) {
  return tool({
    description: "Delete a job and all its nodes and test cases.",
    inputSchema: removeJobToolInputSchema,
    execute: async ({ jobId }: { jobId: string }): Promise<{ success: boolean; message: string }> => {
      try {
        const storageService: JobStorageService = JobStorageService.getInstance();
        await storageService.deleteJobAsync(jobId);

        const activeMode = creationModeTracker.getMode();

        if (activeMode && activeMode.jobId === jobId) {
          creationModeTracker.clearMode();
        }

        return { success: true, message: "Job removed successfully." };
      } catch (error: unknown) {
        return { success: false, message: (error as Error).message };
      }
    },
  });
}
