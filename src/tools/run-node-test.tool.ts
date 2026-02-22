import { tool } from "ai";
import { runNodeTestToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INodeTestResult, INodeTestCase, IAgentToolCall } from "../shared/types/index.js";

export const runNodeTestTool = tool({
  description: "Run all test cases for a node and report results.",
  inputSchema: runNodeTestToolInputSchema,
  execute: async ({ jobId, nodeId }: { jobId: string; nodeId: string }): Promise<{ results: Array<{ testId: string; name: string; passed: boolean; error: string | null; validationErrors: string[]; executionTimeMs: number; output: unknown; toolCallHistory?: IAgentToolCall[] }>; allPassed: boolean }> => {
    const executorService: JobExecutorService = JobExecutorService.getInstance();
    const storageService: JobStorageService = JobStorageService.getInstance();
    const testResults = await executorService.runNodeTestsAsync(jobId, nodeId);
    const testCases: INodeTestCase[] = await storageService.getTestCasesAsync(jobId, nodeId);

    const testCaseMap: Map<string, string> = new Map<string, string>();

    for (const tc of testCases) {
      testCaseMap.set(tc.testId, tc.name);
    }

    return {
      results: testResults.results.map((r: INodeTestResult) => ({
        testId: r.testId,
        name: testCaseMap.get(r.testId) ?? "",
        passed: r.passed,
        error: r.error,
        validationErrors: r.validationErrors,
        executionTimeMs: r.executionTimeMs,
        output: r.output,
        toolCallHistory: r.toolCallHistory,
      })),
      allPassed: testResults.allPassed,
    };
  },
});
