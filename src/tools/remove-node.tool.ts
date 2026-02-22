import { tool } from "ai";
import { removeNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

export const removeNodeTool = tool({
  description: "Remove a node from a job. Also removes its test cases.",
  inputSchema: removeNodeToolInputSchema,
  execute: async (
    { jobId, nodeId }: { jobId: string; nodeId: string },
  ): Promise<{ success: boolean; message: string; graphAscii?: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      await storageService.deleteNodeAsync(jobId, nodeId);

      const updatedJob = await storageService.getJobAsync(jobId);

      if (!updatedJob) {
        return { success: false, message: `Job not found: ${jobId}` };
      }

      const updatedNodes = await storageService.listNodesAsync(jobId);
      const graphAscii: string = buildAsciiGraph(updatedNodes, updatedJob.entrypointNodeId);

      return { success: true, message: "Node removed successfully.", graphAscii };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
