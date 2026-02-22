import { tool } from "ai";
import { addCurlFetcherNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { validateFetcherConfigAsync } from "../utils/node-validation.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { ICurlFetcherConfig } from "../shared/types/index.js";

export function createAddCurlFetcherNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add a curl_fetcher node to a job in job creation mode. The URL is probed for reachability " +
      "before the node is created. Use parentNodeId to automatically connect the parent node to this one.",
    inputSchema: addCurlFetcherNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      url,
      method,
      headers,
      body,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: Record<string, unknown>;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }): Promise<ICreateNodeResult> => {
      try {
        const config: ICurlFetcherConfig = { url, method, headers, body };
        const validation = await validateFetcherConfigAsync("curl_fetcher", config as unknown as Record<string, unknown>);

        if (!validation.valid) {
          return { nodeId: "", success: false, message: validation.error, error: validation.error };
        }

        return await createNodeAsync(
          jobId,
          "curl_fetcher",
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
