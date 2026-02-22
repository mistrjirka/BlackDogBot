import { tool } from "ai";
import { addRssFetcherNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { validateFetcherConfigAsync } from "../utils/node-validation.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { IRssFetcherConfig, RssFetchMode } from "../shared/types/index.js";

export function createAddRssFetcherNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add an rss_fetcher node to a job in job creation mode. The feed URL is probed for reachability " +
      "before the node is created. Use parentNodeId to automatically connect the parent node to this one.",
    inputSchema: addRssFetcherNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      url,
      mode,
      maxItems,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: Record<string, unknown>;
      url: string;
      mode: RssFetchMode;
      maxItems: number;
    }): Promise<ICreateNodeResult> => {
      try {
        const config: IRssFetcherConfig = { url, mode, maxItems };
        const validation = await validateFetcherConfigAsync("rss_fetcher", config as unknown as Record<string, unknown>);

        if (!validation.valid) {
          return { nodeId: "", success: false, message: validation.error, error: validation.error };
        }

        return await createNodeAsync(
          jobId,
          "rss_fetcher",
          name,
          description,
          {},
          outputSchema,
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
