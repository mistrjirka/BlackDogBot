import { tool } from "ai";
import { z } from "zod";
import { editNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IJob, NodeConfig } from "../shared/types/index.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { IOutputSchemaBlueprint } from "../shared/schemas/output-schema-blueprint.schema.js";
import { convertOutputSchemaBlueprintToJsonSchema } from "../utils/output-schema-blueprint.js";

export function createEditNodeTool(tracker: IJobActivityTracker) {
  return tool({
    description: "Update an existing node's name, description, schemas, or configuration.",
    inputSchema: editNodeToolInputSchema,
    execute: async ({ jobId, nodeId, name, description, inputSchema, outputSchema, config }: { jobId: string; nodeId: string; name?: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: IOutputSchemaBlueprint; config?: Record<string, unknown> }): Promise<{ success: boolean; message: string }> => {
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

        const updates: Record<string, unknown> = {};

        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (inputSchema !== undefined) updates.inputSchema = inputSchema;
        if (outputSchema !== undefined) {
          updates.outputSchema = convertOutputSchemaBlueprintToJsonSchema(outputSchema);
        }
        if (config !== undefined) updates.config = config as NodeConfig;

        await storageService.updateNodeAsync(jobId, nodeId, updates);

        // Track that this job was modified (node edited)
        const job: IJob | null = await storageService.getJobAsync(jobId);
        const trackedName: string = job?.name ?? jobId;

        tracker.trackModified(jobId, trackedName);

        return { success: true, message: "Node updated successfully." };
      } catch (error: unknown) {
        return { success: false, message: (error as Error).message };
      }
    },
  });
}
