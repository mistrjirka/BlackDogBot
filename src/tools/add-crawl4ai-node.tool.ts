import { tool } from "ai";
import { addCrawl4aiNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { validateFetcherConfigAsync } from "../utils/node-validation.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { ICrawl4AiConfig } from "../shared/types/index.js";

export function createAddCrawl4aiNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add a crawl4ai node to a job in job creation mode. The target URL and Crawl4AI service are " +
      "probed for reachability before the node is created. Use parentNodeId to automatically connect " +
      "the parent node to this one.",
    inputSchema: addCrawl4aiNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      url,
      extractionPrompt,
      selector,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: Record<string, unknown>;
      url: string;
      extractionPrompt: string | null;
      selector: string | null;
    }): Promise<ICreateNodeResult> => {
      try {
        const config: ICrawl4AiConfig = { url, extractionPrompt, selector };
        const validation = await validateFetcherConfigAsync("crawl4ai", config as unknown as Record<string, unknown>);

        if (!validation.valid) {
          return { nodeId: "", success: false, message: validation.error, error: validation.error };
        }

        return await createNodeAsync(
          jobId,
          "crawl4ai",
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
