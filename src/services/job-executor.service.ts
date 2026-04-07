import type { INodeProgressEvent, INodeTestResult } from "../shared/types/index.js";

export class JobExecutorService {
  private static _instance: JobExecutorService | null = null;

  public static getInstance(): JobExecutorService {
    if (!JobExecutorService._instance) {
      JobExecutorService._instance = new JobExecutorService();
    }
    return JobExecutorService._instance;
  }

  public async runNodeTestsAsync(_jobId: string, _nodeId: string): Promise<{ results: INodeTestResult[] }> {
    return { results: [] };
  }

  public async executeJobAsync(
    _jobId: string,
    _options: Record<string, unknown>,
    _onProgress?: (event: INodeProgressEvent) => void,
  ): Promise<{ success: boolean; output?: Record<string, unknown>; nodesExecuted?: number; nodeResults?: unknown[] }> {
    return { success: false, output: {}, nodesExecuted: 0, nodeResults: [] };
  }
}
