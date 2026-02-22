//#region Interfaces

export interface IJobCreationMode {
  jobId: string;
  startNodeId: string;
}

export interface IJobCreationModeTracker {
  setMode(jobId: string, startNodeId: string): void;
  clearMode(): void;
  getMode(): IJobCreationMode | null;
}

//#endregion Interfaces
