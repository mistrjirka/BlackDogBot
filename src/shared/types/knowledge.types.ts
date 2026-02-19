//#region Knowledge Types

export interface IKnowledgeDocument {
  id: string;
  content: string;
  collection: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IKnowledgeSearchResult {
  id: string;
  content: string;
  collection: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface IKnowledgeSearchOptions {
  collection: string;
  query: string;
  limit: number;
  filter: Record<string, unknown> | null;
}

//#endregion Knowledge Types
