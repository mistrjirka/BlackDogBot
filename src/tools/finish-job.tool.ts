import { tool } from "ai";
import { finishJobToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { IJob, INode, INodeTestCase } from "../shared/types/index.js";
import { validateGraph, IGraphValidationResult } from "../jobs/graph.js";

export const finishJobTool = tool({
  description:
    "Mark a job as ready for execution. Validates the graph structure and ensures every node has " +
    "at least one test case with all tests passing. You must add tests (add_node_test) and run them " +
    "(run_node_test) for every node before calling this tool.",
  inputSchema: finishJobToolInputSchema,
  execute: async ({ jobId }: { jobId: string }): Promise<{ success: boolean; message: string; validationErrors: string[] }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();

      const job: IJob | null = await storageService.getJobAsync(jobId);

      if (!job) {
        return { success: false, message: `Job "${jobId}" not found.`, validationErrors: [] };
      }

      if (job.status !== "creating") {
        return { success: false, message: `Job is already in "${job.status}" status.`, validationErrors: [] };
      }

      const nodes: INode[] = await storageService.listNodesAsync(jobId);
      const validationResult: IGraphValidationResult = validateGraph(nodes, job.entrypointNodeId);

      if (!validationResult.valid) {
        return { success: false, message: "Job graph validation failed.", validationErrors: validationResult.errors };
      }

      // Enforce: every node must have at least one test case
      const nodesWithoutTests: string[] = [];

      for (const node of nodes) {
        const testCases: INodeTestCase[] = await storageService.getTestCasesAsync(jobId, node.nodeId);

        if (testCases.length === 0) {
          nodesWithoutTests.push(`"${node.name}" (${node.nodeId})`);
        }
      }

      if (nodesWithoutTests.length > 0) {
        return {
          success: false,
          message: `The following nodes have no test cases. Add at least one test per node using add_node_test, then run them with run_node_test: ${nodesWithoutTests.join(", ")}`,
          validationErrors: [],
        };
      }

      // Enforce: all node tests must pass
      const executorService: JobExecutorService = JobExecutorService.getInstance();
      const failedNodes: string[] = [];

      for (const node of nodes) {
        const testResult = await executorService.runNodeTestsAsync(jobId, node.nodeId);

        if (!testResult.allPassed) {
          const failedCount: number = testResult.results.filter((r) => !r.passed).length;

          failedNodes.push(`"${node.name}" (${node.nodeId}): ${failedCount} test(s) failed`);
        }
      }

      if (failedNodes.length > 0) {
        return {
          success: false,
          message: `Node tests must all pass before finishing the job. Failing nodes: ${failedNodes.join("; ")}. Fix the issues and re-run tests with run_node_test.`,
          validationErrors: [],
        };
      }

      await storageService.updateJobAsync(jobId, { status: "ready" });

      return { success: true, message: "Job is now ready for execution. All nodes validated and tests passed.", validationErrors: [] };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message, validationErrors: [] };
    }
  },
});
