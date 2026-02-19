import { tool } from "ai";
import { setEntrypointToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INode } from "../shared/types/index.js";

export const setEntrypointTool = tool({
  description: "Set the entrypoint node for a job. This is the first node that receives input when the job runs.",
  inputSchema: setEntrypointToolInputSchema,
  execute: async ({ jobId, nodeId }: { jobId: string; nodeId: string }): Promise<{ success: boolean; message: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();

      const node: INode | null = await storageService.getNodeAsync(jobId, nodeId);

      if (!node) {
        return { success: false, message: `Node "${nodeId}" not found in job "${jobId}".` };
      }

      await storageService.updateJobAsync(jobId, { entrypointNodeId: nodeId });

      return { success: true, message: `Entrypoint set to node "${nodeId}" (${node.name}).` };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
