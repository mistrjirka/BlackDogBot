import { tool } from "ai";
import { removeNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";

export const removeNodeTool = tool({
  description: "Remove a node from a job. Also removes its test cases.",
  inputSchema: removeNodeToolInputSchema,
  execute: async ({ jobId, nodeId }: { jobId: string; nodeId: string }): Promise<{ success: boolean; message: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      await storageService.deleteNodeAsync(jobId, nodeId);

      return { success: true, message: "Node removed successfully." };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
