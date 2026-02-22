import { tool } from "ai";

import { getNodesToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IJob, INode } from "../shared/types/index.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

export const getNodesTool = tool({
  description:
    "List all nodes in a job with their full details including input/output schemas, config, and connections. Also returns an ASCII art visualization of the graph topology.",
  inputSchema: getNodesToolInputSchema,
  execute: async ({ jobId }: { jobId: string }) => {
    const storage: JobStorageService = JobStorageService.getInstance();

    const job: IJob | null = await storage.getJobAsync(jobId);

    if (!job) {
      return { success: false, error: `Job not found: ${jobId}` };
    }

    const nodes: INode[] = await storage.listNodesAsync(jobId);

    const asciiGraph: string = buildAsciiGraph(nodes, job.entrypointNodeId);

    return {
      jobId: job.jobId,
      jobName: job.name,
      entrypointNodeId: job.entrypointNodeId,
      nodeCount: nodes.length,
      nodes: nodes.map((n: INode) => ({
        nodeId: n.nodeId,
        name: n.name,
        type: n.type,
        description: n.description,
        inputSchema: n.inputSchema,
        outputSchema: n.outputSchema,
        connections: n.connections,
        config: n.config as Record<string, unknown>,
        isEntrypoint: n.nodeId === job.entrypointNodeId,
      })),
      asciiGraph,
    };
  },
});
