import { tool } from "ai";
import { doneToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker, type IJobActivity } from "../utils/job-activity-tracker.js";

//#region Interfaces

interface IDoneToolResult {
  finished: boolean;
  error?: string;
  untestedJobs?: Array<{ jobId: string; jobName: string }>;
}

//#endregion Interfaces

//#region Factory

export function createDoneTool(tracker: IJobActivityTracker) {
  return tool({
    description:
      "Call this tool when you have completed the user's request. Provide a summary of what was accomplished. " +
      "IMPORTANT: If you created or modified any jobs during this session, you MUST run each job successfully (using run_job) " +
      "before calling this tool. The tool will reject your call if any jobs remain untested.",
    inputSchema: doneToolInputSchema,
    execute: async ({ summary }: { summary: string }): Promise<IDoneToolResult> => {
      if (tracker.hasUntestedJobs()) {
        const untested: IJobActivity[] = tracker.getUntestedJobs();
        const jobList: string = untested
          .map((j: IJobActivity): string => `"${j.jobName}" (${j.jobId})`)
          .join(", ");

        return {
          finished: false,
          error: `Cannot finish: the following jobs were created or modified but have not been successfully run yet: ${jobList}. ` +
            "You must run each job with run_job and verify it succeeds before calling done.",
          untestedJobs: untested.map((j: IJobActivity) => ({ jobId: j.jobId, jobName: j.jobName })),
        };
      }

      void summary;

      return { finished: true };
    },
  });
}

//#endregion Factory

/**
 * Standalone done tool for agents that don't need job tracking (e.g. CronAgent).
 */
export const doneTool = tool({
  description: "Call this tool when you have completed the user's request. Provide a summary of what was accomplished.",
  inputSchema: doneToolInputSchema,
  execute: async ({ summary }: { summary: string }): Promise<{ finished: boolean }> => {
    void summary;
    return { finished: true };
  },
});
