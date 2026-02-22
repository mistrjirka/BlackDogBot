import { tool } from "ai";
import { addAgentNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { IAgentNodeConfig } from "../shared/types/index.js";

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
    }): Promise<ICreateNodeResult> => {
      try {
        const config: IAgentNodeConfig = { systemPrompt, selectedTools, model, reasoningEffort, maxSteps };

        return await createNodeAsync(
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
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
