//#region Interfaces

export interface IJobCreationMode {
  jobId: string;
  startNodeId: string;
  /** Whether an LLM audit has been attempted at least once */
  auditAttempted: boolean;
}

export interface IJobCreationModeTracker {
  setMode(jobId: string, startNodeId: string): void;
  clearMode(): void;
  getMode(): IJobCreationMode | null;
  /** Mark that an audit has been attempted for the current job */
  markAuditAttempted(): void;
}

//#endregion Interfaces
