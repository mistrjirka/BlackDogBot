import { tool } from "ai";
import { addPythonCodeNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { IPythonCodeConfig } from "../shared/types/index.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";

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
    }): Promise<ICreateNodeResult & { graphAscii?: string }> => {
      try {
        const sqliteImportPattern: RegExp = /(\bimport\s+sqlite\w*\b|\bfrom\s+sqlite\w*\s+import\b)/i;
        const sqliteUsagePattern: RegExp = /\bsqlite\w*\s*\./i;

        if (sqliteImportPattern.test(code) || sqliteUsagePattern.test(code)) {
          throw new Error(
            "Python sqlite libraries are not allowed. Use the database nodes instead: create_table, write_to_database, and query_database. If the task cannot be expressed with these nodes, tell the user which database node is missing.",
          );
        }

        const config: IPythonCodeConfig = { code, pythonPath, timeout };

        const result: ICreateNodeResult = await createNodeAsync(
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

        if (!result.success) {
          return result;
        }

        const storageService: JobStorageService = JobStorageService.getInstance();
        const job = await storageService.getJobAsync(jobId);
        const nodes = await storageService.listNodesAsync(jobId);
        const graphAscii: string = buildAsciiGraph(nodes, job?.entrypointNodeId ?? null);

        return { ...result, graphAscii };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
