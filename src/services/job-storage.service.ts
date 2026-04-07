import type { IJob, INode, INodeTestCase } from "../shared/types/index.js";

export class JobStorageService {
  private static _instance: JobStorageService | null = null;

  public static getInstance(): JobStorageService {
    if (!JobStorageService._instance) {
      JobStorageService._instance = new JobStorageService();
    }
    return JobStorageService._instance;
  }

  public get events(): { on(_event: string, _callback: (data: { jobId: string }) => void): void } {
    return { on: (): void => {} };
  }

  public async getJobAsync(_jobId: string): Promise<IJob | null> {
    return null;
  }

  public async listNodesAsync(_jobId: string): Promise<INode[]> {
    return [];
  }

  public async listJobsAsync(): Promise<IJob[]> {
    return [];
  }

  public async getTestCasesAsync(_jobId: string, _nodeId: string): Promise<INodeTestCase[]> {
    return [];
  }
}
