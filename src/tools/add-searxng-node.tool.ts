import { tool } from "ai";
import { addSearxngNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { validateFetcherConfigAsync } from "../utils/node-validation.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { ISearxngConfig } from "../shared/types/index.js";
import { IOutputSchemaBlueprint } from "../shared/schemas/output-schema-blueprint.schema.js";
import { convertOutputSchemaBlueprintToJsonSchema } from "../utils/output-schema-blueprint.js";
import { extractErrorMessage } from "../utils/error.js";

export function createAddSearxngNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add a searxng node to a job in job creation mode. The SearXNG service is probed for " +
      "reachability before the node is created. Use parentNodeId to automatically connect the " +
      "parent node to this one.",
    inputSchema: addSearxngNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      query,
      categories,
      maxResults,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: IOutputSchemaBlueprint;
      query: string;
      categories: string[];
      maxResults: number;
    }): Promise<ICreateNodeResult> => {
      try {
        const config: ISearxngConfig = { query, categories, maxResults };
        const outputJsonSchema: Record<string, unknown> = convertOutputSchemaBlueprintToJsonSchema(outputSchema);
        const validation = await validateFetcherConfigAsync("searxng", config as unknown as Record<string, unknown>);

        if (!validation.valid) {
          return { nodeId: "", success: false, message: validation.error, error: validation.error };
        }

        return await createNodeAsync(
          jobId,
          "searxng",
          name,
          description,
          {},
          outputJsonSchema,
          config,
          parentNodeId,
          jobTracker,
        );
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
