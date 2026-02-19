import { tool } from "ai";
import { connectNodesToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INode } from "../shared/types/index.js";
import { checkSchemaCompatibility, ISchemaCompatResult } from "../jobs/schema-compat.js";

export const connectNodesTool = tool({
  description: "Connect two nodes in a job. The output of the source node will feed into the target node.",
  inputSchema: connectNodesToolInputSchema,
  execute: async ({ jobId, fromNodeId, toNodeId }: { jobId: string; fromNodeId: string; toNodeId: string }): Promise<{ success: boolean; message: string; schemaCompatible: boolean }> => {
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

      // Check schema compatibility
      const compatResult: ISchemaCompatResult = checkSchemaCompatibility(fromNode.outputSchema, toNode.inputSchema);

      // Add connection
      const updatedConnections: string[] = [...fromNode.connections];

      if (!updatedConnections.includes(toNodeId)) {
        updatedConnections.push(toNodeId);
      }

      await storageService.updateNodeAsync(jobId, fromNodeId, { connections: updatedConnections });

      const message: string = compatResult.compatible
        ? "Nodes connected successfully. Schemas are compatible."
        : `Nodes connected but schemas may be incompatible: ${compatResult.errors.join(", ")}`;

      return { success: true, message, schemaCompatible: compatResult.compatible };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message, schemaCompatible: false };
    }
  },
});
