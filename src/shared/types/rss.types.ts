export interface IRssState {
  feedUrl: string;
  lastPublishedDate: string | null;
  seenGuids: string[];
}
