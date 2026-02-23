import { tool } from "ai";
import { z } from "zod";
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
      const allNodes = await storageService.listNodesAsync(jobId);
      const existingNodeIds: string[] = allNodes.map((node): string => node.nodeId);

      if (existingNodeIds.length === 0) {
        return { success: false, message: `No nodes found in job \"${jobId}\".` };
      }

      const existingNodeIdSchema = z.enum(existingNodeIds as [string, ...string[]]);
      const parsed = existingNodeIdSchema.safeParse(nodeId);

      if (!parsed.success) {
        return {
          success: false,
          message: `Invalid nodeId for job \"${jobId}\": ${parsed.error.issues[0]?.message ?? "Unknown validation error."}`,
        };
      }

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
