import { tool } from "ai";
import { z } from "zod";
import { JobStorageService } from "../services/job-storage.service.js";
import { type IJob, type INode } from "../shared/types/index.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";
import { extractErrorMessage } from "../utils/error.js";

export const clearJobGraphTool = tool({
  description:
    "Clear a job graph by removing all nodes, edges, test cases, and the entrypoint. Returns the cleared node count and the empty graph ASCII.",
  inputSchema: z.object({
    jobId: z.string().min(1).describe("Job ID"),
  }),
  execute: async ({
    jobId,
  }: {
    jobId: string;
  }): Promise<{ success: boolean; message: string; clearedNodesCount: number; graphAscii: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return {
          success: false,
          message: `Job not found: ${jobId}`,
          clearedNodesCount: 0,
          graphAscii: buildAsciiGraph([], null),
        };
      }

      const nodes: INode[] = await storageService.listNodesAsync(jobId);

      for (const node of nodes) {
        await storageService.deleteNodeAsync(jobId, node.nodeId);
      }

      const updatedJob: IJob = await storageService.updateJobAsync(jobId, { entrypointNodeId: null });
      const remainingNodes: INode[] = await storageService.listNodesAsync(jobId);
      const graphAscii: string = buildAsciiGraph(remainingNodes, updatedJob.entrypointNodeId);
      const clearedNodesCount: number = nodes.length;
      const message: string =
        clearedNodesCount === 0
          ? `Job "${job.name}" graph is already empty.`
          : `Cleared ${clearedNodesCount} node${clearedNodesCount === 1 ? "" : "s"} from job "${job.name}".`;

      return { success: true, message, clearedNodesCount, graphAscii };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      return {
        success: false,
        message: errorMessage,
        clearedNodesCount: 0,
        graphAscii: buildAsciiGraph([], null),
      };
    }
  },
});
