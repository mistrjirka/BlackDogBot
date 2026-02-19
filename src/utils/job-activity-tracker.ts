//#region Interfaces

export interface IJobActivity {
  jobId: string;
  jobName: string;
  created: boolean;
  modified: boolean;
  ranSuccessfully: boolean;
}

export interface IJobActivityTracker {
  trackCreated(jobId: string, jobName: string): void;
  trackModified(jobId: string, jobName: string): void;
  trackRanSuccessfully(jobId: string): void;
  getUntestedJobs(): IJobActivity[];
  hasUntestedJobs(): boolean;
}

//#endregion Interfaces

//#region JobActivityTracker

export class JobActivityTracker implements IJobActivityTracker {
  //#region Data members

  private _activities: Map<string, IJobActivity>;

  //#endregion Data members

  //#region Constructors

  public constructor() {
    this._activities = new Map<string, IJobActivity>();
  }

  //#endregion Constructors

  //#region Public methods

  public trackCreated(jobId: string, jobName: string): void {
    this._activities.set(jobId, {
      jobId,
      jobName,
      created: true,
      modified: false,
      ranSuccessfully: false,
    });
  }

  public trackModified(jobId: string, jobName: string): void {
    const existing: IJobActivity | undefined = this._activities.get(jobId);

    if (existing) {
      existing.modified = true;
      existing.jobName = jobName;
      // Reset ran status since the job was modified after last run
      existing.ranSuccessfully = false;
    } else {
      this._activities.set(jobId, {
        jobId,
        jobName,
        created: false,
        modified: true,
        ranSuccessfully: false,
      });
    }
  }

  public trackRanSuccessfully(jobId: string): void {
    const existing: IJobActivity | undefined = this._activities.get(jobId);

    if (existing) {
      existing.ranSuccessfully = true;
    }
  }

  public getUntestedJobs(): IJobActivity[] {
    const untested: IJobActivity[] = [];

    for (const activity of this._activities.values()) {
      if (!activity.ranSuccessfully) {
        untested.push(activity);
      }
    }

    return untested;
  }

  public hasUntestedJobs(): boolean {
    for (const activity of this._activities.values()) {
      if (!activity.ranSuccessfully) {
        return true;
      }
    }

    return false;
  }

  //#endregion Public methods
}

//#endregion JobActivityTracker
