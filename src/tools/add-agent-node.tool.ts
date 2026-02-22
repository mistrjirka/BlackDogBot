import { tool } from "ai";
import { addAgentNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IAgentNodeConfig, IJob, INode } from "../shared/types/index.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { getAgentNodeToolNames } from "../utils/agent-node-tool-pool.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

export function createAddAgentNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add an agent node to a job in job creation mode. The agent runs with the given system prompt " +
      "and has access to the specified tools. Use parentNodeId to automatically connect the parent " +
      "node to this one.",
    inputSchema: addAgentNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      systemPrompt,
      selectedTools,
      model,
      reasoningEffort,
      maxSteps,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: Record<string, unknown>;
      systemPrompt: string;
      selectedTools: string[];
      model: string | null;
      reasoningEffort: "low" | "medium" | "high" | null;
      maxSteps: number;
    }): Promise<ICreateNodeResult & { graphAscii?: string }> => {
      try {
        if (!Array.isArray(selectedTools) || selectedTools.length === 0) {
          const availableTools: string[] = getAgentNodeToolNames();
          throw new Error(
            "The agent doesn't have any tools. Please select some from the available tools: " +
              availableTools.join(", "),
          );
        }

        const config: IAgentNodeConfig = { systemPrompt, selectedTools, model, reasoningEffort, maxSteps };

        const result: ICreateNodeResult = await createNodeAsync(
          jobId,
          "agent",
          name,
          description,
          {},
          outputSchema,
          config,
          parentNodeId,
          jobTracker,
        );

        if (!result.success) {
          return result;
        }

        const storageService: JobStorageService = JobStorageService.getInstance();
        const updatedJob: IJob | null = await storageService.getJobAsync(jobId);
        const nodes: INode[] = await storageService.listNodesAsync(jobId);
        const graphAscii: string = buildAsciiGraph(nodes, updatedJob ? updatedJob.entrypointNodeId : null);

        return { ...result, graphAscii };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
