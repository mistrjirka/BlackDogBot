// Extracted to break circular dependency between per-table-tools.ts and update-table.tool.ts

import { z } from "zod";

export const SQLITE_TO_ZOD_TYPE: Record<string, z.ZodType> = {
  // Text types
  TEXT: z.string(),
  VARCHAR: z.string(),
  CHAR: z.string(),
  CLOB: z.string(),
  STRING: z.string(),
  // Integer types
  INTEGER: z.number().int(),
  INT: z.number().int(),
  SMALLINT: z.number().int(),
  TINYINT: z.number().int(),
  BIGINT: z.number().int(),
  // Floating point types
  REAL: z.number(),
  FLOAT: z.number(),
  DOUBLE: z.number(),
  NUMERIC: z.number(),
  DECIMAL: z.number(),
  // Binary
  BLOB: z.string(),
  // Boolean
  BOOLEAN: z.union([z.literal(0), z.literal(1), z.boolean()]),
  BOOL: z.union([z.literal(0), z.literal(1), z.boolean()]),
  // Date/time types
  DATE: z.string(),
  DATETIME: z.string(),
  TIMESTAMP: z.string(),
};

export const COMMON_TIMESTAMP_COLUMNS: Set<string> = new Set([
  "created_at",
  "updated_at",
  "timestamp",
  "created",
  "updated",
]);

export const DATE_LIKE_TYPES: Set<string> = new Set(["DATE", "DATETIME", "TIMESTAMP"]);
