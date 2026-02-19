import { tool } from "ai";

import { renderGraphToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { buildDotDiagram, renderGraphToImageAsync } from "../utils/graph-renderer.js";
import { LoggerService } from "../services/logger.service.js";
import { type IJob, type INode } from "../shared/types/index.js";

//#region Types

export type PhotoSender = (imageBuffer: Buffer, caption: string | null) => Promise<string | null>;

//#endregion Types

//#region Tool factory

export function createRenderGraphTool(photoSender: PhotoSender) {
  return tool({
    description:
      "Render a job's node graph as a visual diagram and send it as an image to the user. Shows nodes, connections, types, and the entrypoint.",
    inputSchema: renderGraphToolInputSchema,
    execute: async ({
      jobId,
    }: {
      jobId: string;
    }): Promise<{ success: boolean; message: string }> => {
      const logger: LoggerService = LoggerService.getInstance();
      const jobStorage: JobStorageService = JobStorageService.getInstance();

      const job: IJob | null = await jobStorage.getJobAsync(jobId);

      if (!job) {
        return { success: false, message: `Job not found: ${jobId}` };
      }

      const nodes: INode[] = await jobStorage.listNodesAsync(jobId);

      if (nodes.length === 0) {
        return { success: false, message: `Job "${job.name}" has no nodes to visualize` };
      }

      logger.debug("Building graph diagram", { jobId, nodeCount: nodes.length });

      const dotCode: string = buildDotDiagram(nodes, job.entrypointNodeId, job.name);
      const imageBuffer: Buffer = await renderGraphToImageAsync(dotCode);

      const caption: string = `Graph: ${job.name} (${nodes.length} nodes)`;
      await photoSender(imageBuffer, caption);

      logger.info("Graph rendered and sent", { jobId, nodeCount: nodes.length });

      return { success: true, message: `Graph for job "${job.name}" rendered and sent (${nodes.length} nodes)` };
    },
  });
}

//#endregion Tool factory
