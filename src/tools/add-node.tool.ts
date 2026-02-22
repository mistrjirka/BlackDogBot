import { tool } from "ai";
import { addNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INode, IJob, NodeType, NodeConfig } from "../shared/types/index.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { validateFetcherConfigAsync } from "../utils/node-validation.js";

//#region Constants

const FETCHER_NODE_TYPES: Set<string> = new Set(["curl_fetcher", "rss_fetcher", "crawl4ai", "searxng"]);

//#endregion Constants

export function createAddNodeTool(tracker: IJobActivityTracker) {
  return tool({
    description: "Add a new node to a job. Define its type, schemas, and configuration. For fetcher nodes (curl_fetcher, rss_fetcher, crawl4ai, searxng), the URL/service is probed to verify reachability before the node is created.",
    inputSchema: addNodeToolInputSchema,
    execute: async ({ jobId, type, name, description, inputSchema, outputSchema, config }: { jobId: string; type: string; name: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; config: Record<string, unknown> }): Promise<{ nodeId: string; success: boolean; error?: string }> => {
      try {
        if (FETCHER_NODE_TYPES.has(type)) {
          const validation = await validateFetcherConfigAsync(type, config);

          if (!validation.valid) {
            return { nodeId: "", success: false, error: validation.error };
          }
        }

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

        // Track that this job was modified (node added)
        const job: IJob | null = await storageService.getJobAsync(jobId);
        const trackedName: string = job?.name ?? jobId;

        tracker.trackModified(jobId, trackedName);

        return { nodeId: node.nodeId, success: true };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);
        return { nodeId: "", success: false, error: errorMessage };
      }
    },
  });
}
