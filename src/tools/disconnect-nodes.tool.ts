import { tool } from "ai";
import { z } from "zod";
import { JobStorageService } from "../services/job-storage.service.js";
import { INode } from "../shared/types/index.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

export const disconnectNodesTool = tool({
  description: "Remove a connection (edge) between two nodes in a job graph. Use this to break an erroneous link.",
  inputSchema: z.object({
    jobId: z.string().min(1).describe("Job ID"),
    fromNodeId: z.string().min(1).describe("Source node ID"),
    toNodeId: z.string().min(1).describe("Target node ID to disconnect from source"),
  }),
  execute: async ({
    jobId,
    fromNodeId,
    toNodeId,
  }: {
    jobId: string;
    fromNodeId: string;
    toNodeId: string;
  }): Promise<{ success: boolean; message: string; graphAscii?: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const allNodes: INode[] = await storageService.listNodesAsync(jobId);
      const existingNodeIds: string[] = allNodes.map((node: INode): string => node.nodeId);

      if (existingNodeIds.length === 0) {
        return { success: false, message: `No nodes found in job "${jobId}".` };
      }

      const existingNodeIdSchema = z.enum(existingNodeIds as [string, ...string[]]);
      const runtimeSchema = z.object({
        fromNodeId: existingNodeIdSchema,
        toNodeId: existingNodeIdSchema,
      }).refine(
        (value): boolean => value.fromNodeId !== value.toNodeId,
        {
          message: "Source and target node IDs must be different.",
          path: ["toNodeId"],
        },
      );

      const parsed = runtimeSchema.safeParse({ fromNodeId, toNodeId });

      if (!parsed.success) {
        if (!existingNodeIds.includes(fromNodeId)) {
          return { success: false, message: `Source node "${fromNodeId}" not found.` };
        }

        if (!existingNodeIds.includes(toNodeId)) {
          return { success: false, message: `Target node "${toNodeId}" not found.` };
        }

        const reason: string = parsed.error.issues
          .map((issue): string => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");

        return { success: false, message: `Invalid node IDs for job "${jobId}": ${reason}` };
      }

      const fromNode: INode | null = await storageService.getNodeAsync(jobId, fromNodeId);

      if (!fromNode) {
        return { success: false, message: `Source node "${fromNodeId}" not found.` };
      }

      const toNode: INode | null = await storageService.getNodeAsync(jobId, toNodeId);

      if (!toNode) {
        return { success: false, message: `Target node "${toNodeId}" not found.` };
      }

      if (!fromNode.connections.includes(toNodeId)) {
        return {
          success: false,
          message: `No connection exists from "${fromNodeId}" to "${toNodeId}".`,
        };
      }

      const updatedConnections: string[] = fromNode.connections.filter(
        (id: string): boolean => id !== toNodeId,
      );

      await storageService.updateNodeAsync(jobId, fromNodeId, { connections: updatedConnections });

      const updatedJob = await storageService.getJobAsync(jobId);

      if (!updatedJob) {
        return { success: false, message: `Job not found: ${jobId}` };
      }

      const updatedNodes: INode[] = await storageService.listNodesAsync(jobId);
      const graphAscii: string = buildAsciiGraph(updatedNodes, updatedJob.entrypointNodeId);

      return {
        success: true,
        message: `Connection from "${fromNode.name}" to "${toNode.name}" removed successfully.`,
        graphAscii,
      };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
