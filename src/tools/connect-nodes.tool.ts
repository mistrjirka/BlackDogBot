import { tool } from "ai";
import { z } from "zod";
import { connectNodesToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INode } from "../shared/types/index.js";
import { checkSchemaCompatibility, ISchemaCompatResult } from "../jobs/schema-compat.js";

//#region Schema

const _connectNodesInputSchema = connectNodesToolInputSchema.extend({
  force: z.boolean()
    .default(false)
    .describe("If true, bypasses schema compatibility check (for expert use). Cycle detection always runs."),
});

//#endregion Schema

//#region Private functions

/**
 * Returns true if `targetId` is reachable from `startId` in the current graph.
 * Uses BFS over existing connections.
 */
function _isReachable(nodes: INode[], startId: string, targetId: string): boolean {
  const nodeMap: Map<string, INode> = new Map(
    nodes.map((n: INode): [string, INode] => [n.nodeId, n]),
  );

  const visited: Set<string> = new Set<string>();
  const queue: string[] = [startId];

  while (queue.length > 0) {
    const current: string = queue.shift()!;

    if (current === targetId) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    const currentNode: INode | undefined = nodeMap.get(current);

    if (currentNode) {
      for (const neighborId of currentNode.connections) {
        if (!visited.has(neighborId)) {
          queue.push(neighborId);
        }
      }
    }
  }

  return false;
}

//#endregion Private functions

//#region Tool

export const connectNodesTool = tool({
  description: "Connect two nodes in a job. The output of the source node will feed into the target node. Connection is blocked if schemas are incompatible or if it would create a cycle.",
  inputSchema: _connectNodesInputSchema,
  execute: async ({
    jobId,
    fromNodeId,
    toNodeId,
    force,
  }: {
    jobId: string;
    fromNodeId: string;
    toNodeId: string;
    force: boolean;
  }): Promise<{ success: boolean; message: string; schemaCompatible: boolean }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();

      const fromNode: INode | null = await storageService.getNodeAsync(jobId, fromNodeId);

      if (!fromNode) {
        return { success: false, message: `Source node "${fromNodeId}" not found.`, schemaCompatible: false };
      }

      const toNode: INode | null = await storageService.getNodeAsync(jobId, toNodeId);

      if (!toNode) {
        return { success: false, message: `Target node "${toNodeId}" not found.`, schemaCompatible: false };
      }

      // Cycle detection — always runs, even when force=true
      const allNodes: INode[] = await storageService.listNodesAsync(jobId);

      if (_isReachable(allNodes, toNodeId, fromNodeId)) {
        return {
          success: false,
          message: `Connection would create a cycle: "${toNode.name}" already has a path back to "${fromNode.name}".`,
          schemaCompatible: true,
        };
      }

      // Schema compatibility check
      const compatResult: ISchemaCompatResult = checkSchemaCompatibility(fromNode.outputSchema, toNode.inputSchema);

      if (!compatResult.compatible && !force) {
        return {
          success: false,
          message: `Schema incompatibility prevents connection: ${compatResult.errors.join("; ")}. Use force=true to override.`,
          schemaCompatible: false,
        };
      }

      // Add connection
      const updatedConnections: string[] = [...fromNode.connections];

      if (!updatedConnections.includes(toNodeId)) {
        updatedConnections.push(toNodeId);
      }

      await storageService.updateNodeAsync(jobId, fromNodeId, { connections: updatedConnections });

      const message: string = compatResult.compatible
        ? "Nodes connected successfully. Schemas are compatible."
        : `Nodes connected (forced). Schema warnings: ${compatResult.errors.join("; ")}")`;

      return { success: true, message, schemaCompatible: compatResult.compatible };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message, schemaCompatible: false };
    }
  },
});

//#endregion Tool
