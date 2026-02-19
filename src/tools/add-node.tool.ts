import { tool } from "ai";
import { addNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INode, NodeType, NodeConfig } from "../shared/types/index.js";

export const addNodeTool = tool({
  description: "Add a new node to a job. Define its type, schemas, and configuration.",
  inputSchema: addNodeToolInputSchema,
  execute: async ({ jobId, type, name, description, inputSchema, outputSchema, config }: { jobId: string; type: string; name: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; config: Record<string, unknown> }): Promise<{ nodeId: string; success: boolean }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const node: INode = await storageService.addNodeAsync(
        jobId,
        type as NodeType,
        name,
        description,
        inputSchema,
        outputSchema,
        config as NodeConfig,
      );

      return { nodeId: node.nodeId, success: true };
    } catch (error: unknown) {
      void error;
      return { nodeId: "", success: false };
    }
  },
});
