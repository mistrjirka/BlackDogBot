import { tool } from "ai";
import { addPythonCodeNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { IPythonCodeConfig } from "../shared/types/index.js";

export function createAddPythonCodeNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add a python_code node to a job in job creation mode. The Python code is executed at " +
      "runtime with the node's input passed as a JSON object. Use parentNodeId to automatically " +
      "connect the parent node to this one.",
    inputSchema: addPythonCodeNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      code,
      pythonPath,
      timeout,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema: Record<string, unknown>;
      code: string;
      pythonPath: string;
      timeout: number;
    }): Promise<ICreateNodeResult> => {
      try {
        const config: IPythonCodeConfig = { code, pythonPath, timeout };

        return await createNodeAsync(
          jobId,
          "python_code",
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
