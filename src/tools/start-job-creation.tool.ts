import { tool } from "ai";
import { startJobCreationToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IJob, INode } from "../shared/types/index.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { type IJobCreationModeTracker } from "../utils/job-creation-mode-tracker.js";
import { extractErrorMessage } from "../utils/error.js";

export function createStartJobCreationTool(
  jobTracker: IJobActivityTracker,
  creationModeTracker: IJobCreationModeTracker,
) {
  return tool({
    description:
      "Begin a guided job creation session. Creates the job and its Start node in one step, " +
      "sets the Start node as the entrypoint, and activates job creation mode which unlocks " +
      "typed node-creation tools (add_curl_fetcher_node, add_rss_fetcher_node, etc.). " +
      "Always call this before adding any nodes to a new job.",
    inputSchema: startJobCreationToolInputSchema,
    execute: async ({
      name,
      description,
      startNodeDescription,
    }: {
      name: string;
      description: string;
      startNodeDescription: string;
    }): Promise<{ jobId: string; startNodeId: string; message: string; error?: string }> => {
      try {
        const existingMode = creationModeTracker.getMode();

        if (existingMode !== null) {
          return {
            jobId: "",
            startNodeId: "",
            message: `Already in job creation mode for job "${existingMode.jobId}". Call finish_job_creation first.`,
            error: `Already in job creation mode for job "${existingMode.jobId}".`,
          };
        }

        const storageService: JobStorageService = JobStorageService.getInstance();

        // 1. Create the job
        const job: IJob = await storageService.createJobAsync(name, description);

        // 2. Create the Start node
        const startNode: INode = await storageService.addNodeAsync(
          job.jobId,
          "start",
          "Start",
          startNodeDescription,
          {},
          {},
          { scheduledTaskId: null },
        );

        // 3. Set the Start node as entrypoint
        await storageService.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId });

        // 4. Activate job creation mode on the current chat session
        creationModeTracker.setMode(job.jobId, startNode.nodeId);

        // 5. Track job as created
        jobTracker.trackCreated(job.jobId, name);

        return {
          jobId: job.jobId,
          startNodeId: startNode.nodeId,
          message:
            `Job "${name}" created (${job.jobId}). Start node created (${startNode.nodeId}). ` +
            "Job creation mode is now active — use add_*_node tools to add nodes, " +
            "specifying parentNodeId to auto-connect. Call finish_job_creation when done.",
        };
      } catch (error: unknown) {
        const errorMessage: string = extractErrorMessage(error);

        return { jobId: "", startNodeId: "", message: errorMessage, error: errorMessage };
      }
    },
  });
}
