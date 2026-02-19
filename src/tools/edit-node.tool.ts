import { tool } from "ai";
import { editNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { NodeConfig } from "../shared/types/index.js";

export const editNodeTool = tool({
  description: "Update an existing node's name, description, schemas, or configuration.",
  inputSchema: editNodeToolInputSchema,
  execute: async ({ jobId, nodeId, name, description, inputSchema, outputSchema, config }: { jobId: string; nodeId: string; name?: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; config?: Record<string, unknown> }): Promise<{ success: boolean; message: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const updates: Record<string, unknown> = {};

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (inputSchema !== undefined) updates.inputSchema = inputSchema;
      if (outputSchema !== undefined) updates.outputSchema = outputSchema;
      if (config !== undefined) updates.config = config as NodeConfig;

      await storageService.updateNodeAsync(jobId, nodeId, updates);

      return { success: true, message: "Node updated successfully." };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
