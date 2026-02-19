import { z } from "zod";

//#region Knowledge Schemas

export const knowledgeDocumentSchema = z.object({
  id: z.string()
    .min(1)
    .describe("Stable document ID"),
  content: z.string()
    .min(1)
    .describe("Knowledge text content"),
  collection: z.string()
    .min(1)
    .default("default")
    .describe("Target collection/table name"),
  metadata: z.record(z.string(), z.unknown())
    .default({})
    .describe("Additional metadata"),
  createdAt: z.string()
    .datetime(),
  updatedAt: z.string()
    .datetime(),
});

export const knowledgeSearchOptionsSchema = z.object({
  collection: z.string()
    .default("default")
    .describe("Collection to search in"),
  query: z.string()
    .min(1)
    .describe("Search query text"),
  limit: z.number()
    .int()
    .positive()
    .default(10)
    .describe("Maximum results to return"),
  filter: z.record(z.string(), z.unknown())
    .nullable()
    .default(null)
    .describe("Optional metadata filter"),
});

export const knowledgeSearchResultSchema = z.object({
  id: z.string(),
  content: z.string(),
  collection: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  score: z.number()
    .describe("Similarity score"),
});

//#endregion Knowledge Schemas
