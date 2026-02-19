import { tool } from "ai";
import { runNodeTestToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { INodeTestResult } from "../shared/types/index.js";

export const runNodeTestTool = tool({
  description: "Run all test cases for a node and report results.",
  inputSchema: runNodeTestToolInputSchema,
  execute: async ({ jobId, nodeId }: { jobId: string; nodeId: string }): Promise<{ results: Array<{ testId: string; name: string; passed: boolean; error: string | null; validationErrors: string[]; executionTimeMs: number }>; allPassed: boolean }> => {
    const executorService: JobExecutorService = JobExecutorService.getInstance();
    const testResults = await executorService.runNodeTestsAsync(jobId, nodeId);

    return {
      results: testResults.results.map((r: INodeTestResult) => ({
        testId: r.testId,
        name: "",
        passed: r.passed,
        error: r.error,
        validationErrors: r.validationErrors,
        executionTimeMs: r.executionTimeMs,
      })),
      allPassed: testResults.allPassed,
    };
  },
});
