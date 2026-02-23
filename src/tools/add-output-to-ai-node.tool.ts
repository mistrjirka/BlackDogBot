import { tool } from "ai";
import { addOutputToAiNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { IOutputToAiConfig } from "../shared/types/index.js";
import { IOutputSchemaBlueprint } from "../shared/schemas/output-schema-blueprint.schema.js";
import { convertOutputSchemaBlueprintToJsonSchema } from "../utils/output-schema-blueprint.js";

export function createAddOutputToAiNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add an output_to_ai node to a job in job creation mode. The prompt template may reference " +
      "outputs from other nodes using {{nodeId.outputKey}} syntax. Use parentNodeId to automatically " +
      "connect the parent node to this one.",
    inputSchema: addOutputToAiNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      prompt,
      model,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: IOutputSchemaBlueprint;
      prompt: string;
      model: string | null;
    }): Promise<ICreateNodeResult> => {
      try {
        const config: IOutputToAiConfig = { prompt, model };
        const outputJsonSchema: Record<string, unknown> = convertOutputSchemaBlueprintToJsonSchema(outputSchema);

        return await createNodeAsync(
          jobId,
          "output_to_ai",
          name,
          description,
          {},
          outputJsonSchema,
          config,
          parentNodeId,
          jobTracker,
        );
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
