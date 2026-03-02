import { tool } from "ai";
import type { z } from "zod";
import { JobStorageService } from "../services/job-storage.service.js";
import { type IJobActivityTracker } from "./job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "./node-creation-helper.js";
import { buildAsciiGraph } from "./ascii-graph.js";
import { extractErrorMessage } from "./error.js";
import type { INode, IJob, NodeConfig, NodeType } from "../shared/types/index.js";

export interface INodeToolOptions<TConfig> {
  nodeType: NodeType;
  description: string;
  inputSchema: z.ZodType;
  buildConfig: (params: Record<string, unknown>) => TConfig;
  outputSchema?: Record<string, unknown>;
  buildOutputSchema?: (params: Record<string, unknown>) => Record<string, unknown>;
  validateConfig?: (
    nodeType: NodeType,
    config: Record<string, unknown>
  ) => Promise<{ valid: boolean; error?: string }>;
  includeGraph?: boolean;
  preValidate?: (params: Record<string, unknown>) => Promise<void> | void;
}

export interface INodeToolResult extends ICreateNodeResult {
  graphAscii?: string;
}

export function createNodeTool<TConfig extends NodeConfig>(
  jobTracker: IJobActivityTracker,
  options: INodeToolOptions<TConfig>
) {
  const {
    nodeType,
    description,
    inputSchema,
    buildConfig,
    outputSchema,
    buildOutputSchema,
    validateConfig,
    includeGraph = true,
    preValidate,
  } = options;

  return tool({
    description,
    inputSchema,
    execute: async (params: Record<string, unknown>): Promise<INodeToolResult> => {
      const { jobId, parentNodeId, name, description: nodeDescription } = params as {
        jobId: string;
        parentNodeId?: string;
        name: string;
        description: string;
      };

      try {
        if (preValidate) {
          await preValidate(params);
        }

        const config = buildConfig(params);
        const finalOutputSchema = buildOutputSchema
          ? buildOutputSchema(params)
          : outputSchema ?? {};

        if (validateConfig) {
          const validation = await validateConfig(nodeType, config as Record<string, unknown>);
          if (!validation.valid) {
            return {
              nodeId: "",
              success: false,
              message: validation.error ?? "Validation failed",
              error: validation.error,
            };
          }
        }

        const result = await createNodeAsync(
          jobId,
          nodeType,
          name,
          nodeDescription,
          {},
          finalOutputSchema,
          config,
          parentNodeId,
          jobTracker
        );

        if (!result.success || !includeGraph) {
          return result;
        }

        const storageService = JobStorageService.getInstance();
        const updatedJob: IJob | null = await storageService.getJobAsync(jobId);
        const nodes: INode[] = await storageService.listNodesAsync(jobId);
        const graphAscii: string = buildAsciiGraph(nodes, updatedJob?.entrypointNodeId ?? null);

        return { ...result, graphAscii };
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);
        return {
          nodeId: "",
          success: false,
          message: errorMessage,
          error: errorMessage,
        };
      }
    },
  });
}

export async function buildGraphAsync(jobId: string): Promise<string> {
  const storageService = JobStorageService.getInstance();
  const job: IJob | null = await storageService.getJobAsync(jobId);
  const nodes: INode[] = await storageService.listNodesAsync(jobId);
  return buildAsciiGraph(nodes, job?.entrypointNodeId ?? null);
}
