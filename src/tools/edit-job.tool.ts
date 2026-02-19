import { tool } from "ai";
import { editJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";

export const editJobTool = tool({
  description: "Update an existing job's name or description.",
  inputSchema: editJobToolInputSchema,
  execute: async ({ jobId, name, description }: { jobId: string; name?: string; description?: string }): Promise<{ success: boolean; message: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const updates: { name?: string; description?: string } = {};

      if (name !== undefined) {
        updates.name = name;
      }

      if (description !== undefined) {
        updates.description = description;
      }

      await storageService.updateJobAsync(jobId, updates);

      return { success: true, message: "Job updated successfully." };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
