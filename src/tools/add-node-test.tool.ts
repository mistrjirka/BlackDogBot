import { tool } from "ai";
import { addNodeTestToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { INodeTestCase } from "../shared/types/index.js";
import { extractErrorMessage } from "../utils/error.js";

export const addNodeTestTool = tool({
  description: "Add a test case to a node. Test cases validate that a node produces correct output for given input.",
  inputSchema: addNodeTestToolInputSchema,
  execute: async ({ jobId, nodeId, name, inputData }: { jobId: string; nodeId: string; name: string; inputData: Record<string, unknown> }): Promise<{ testId: string; success: boolean; error?: string }> => {
    try {
      const storageService: JobStorageService = JobStorageService.getInstance();
      const testCase: INodeTestCase = await storageService.addTestCaseAsync(jobId, nodeId, name, inputData);

      return { testId: testCase.testId, success: true };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      return { testId: "", success: false, error: errorMessage };
    }
  },
});
