import { tool } from "ai";
import { addRssFetcherNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { validateFetcherConfigAsync } from "../utils/node-validation.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { IRssFetcherConfig, RssFetchMode } from "../shared/types/index.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

//#region Constants

const RSS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    link: { type: "string" },
    items: {
      type: "array",
      items: { type: "object" },
    },
    totalItems: { type: "number" },
    feedUrl: { type: "string" },
    mode: { type: "string" },
    unseenCount: { type: "number" },
  },
  required: ["items", "totalItems", "feedUrl", "mode"],
};

//#endregion Constants

export function createAddRssFetcherNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add an rss_fetcher node to a job in job creation mode. The feed URL is probed for reachability " +
      "before the node is created, and the output schema is set to the RSS fetcher defaults. Use parentNodeId " +
      "to automatically connect the parent node to this one.",
    inputSchema: addRssFetcherNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      url,
      mode,
      maxItems,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      url: string;
      mode: RssFetchMode;
      maxItems: number;
    }): Promise<ICreateNodeResult & { graphAscii?: string }> => {
      try {
        const config: IRssFetcherConfig = { url, mode, maxItems };
        const validation = await validateFetcherConfigAsync("rss_fetcher", config as unknown as Record<string, unknown>);

        if (!validation.valid) {
          return { nodeId: "", success: false, message: validation.error, error: validation.error };
        }

        const result: ICreateNodeResult = await createNodeAsync(
          jobId,
          "rss_fetcher",
          name,
          description,
          {},
          RSS_OUTPUT_SCHEMA,
          config,
          parentNodeId,
          jobTracker,
        );

        if (!result.success) {
          return result;
        }

        const storageService: JobStorageService = JobStorageService.getInstance();
        const updatedJob = await storageService.getJobAsync(jobId);
        const updatedNodes = await storageService.listNodesAsync(jobId);
        const graphAscii: string = buildAsciiGraph(updatedNodes, updatedJob?.entrypointNodeId ?? null);

        return { ...result, graphAscii };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
