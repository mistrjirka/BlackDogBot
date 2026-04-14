import { dynamicTool, type ToolSet } from "ai";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import type { IQueryResult } from "../helpers/litesql.js";

const DEFAULT_DATABASE = "blackdog";

const SQL_CLAUSES_IN_WHERE_REGEX = /\b(ORDER\s+BY|LIMIT|SELECT|JOIN|GROUP\s+BY|HAVING)\b|;/i;
const SQL_CLAUSES_IN_ORDER_BY_REGEX = /\b(WHERE|LIMIT|SELECT|JOIN|GROUP\s+BY|HAVING)\b|;/i;
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const _DefaultReadDbLimit = _resolveDefaultReadDbLimit();

function _resolveDefaultReadDbLimit(): number {
  const rawValue: string = (process.env.BLACKDOGBOT_READ_DB_DEFAULT_LIMIT ?? "").trim();
  if (rawValue.length === 0) {
    return 20;
  }

  const parsedValue: number = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue)) {
    return 20;
  }

  return Math.min(50, Math.max(1, parsedValue));
}

function _buildTableNameSchema(tableNames: string[]): z.ZodType<string> {
  const normalizedNames: string[] = tableNames
    .map((name: string): string => name.trim())
    .filter((name: string): boolean => name.length > 0);

  const uniqueNames: string[] = [...new Set(normalizedNames)];

  if (uniqueNames.length === 1) {
    return z.literal(uniqueNames[0]).describe("Name of the table to read from");
  }

  if (uniqueNames.length > 1) {
    return z.enum(uniqueNames as [string, ...string[]]).describe("Name of the table to read from");
  }

  return z.string()
    .regex(IDENTIFIER_REGEX, "Table name must be a plain identifier")
    .describe("Name of the table to read from");
}

export function buildReadFromDatabaseTool(tableNames: string[]): ToolSet[string] {
  const tableNameSchema: z.ZodType<string> = _buildTableNameSchema(tableNames);
  const inputSchema = z.object({
    tableName: tableNameSchema,
    where: z.string()
      .describe("SQL WHERE predicates only (e.g. \"is_interesting = 1 AND pub_date >= '2024-01-01'\"). Do not include ORDER BY or LIMIT here.")
      .optional()
      .refine(
        (value: string | undefined): boolean => value === undefined || !SQL_CLAUSES_IN_WHERE_REGEX.test(value),
        "where must contain only filter predicates. Use orderBy for sorting and limit for row count.",
      ),
    orderBy: z.string()
      .describe("SQL ORDER BY clause only (e.g. \"pub_date DESC\"). Do not include WHERE or LIMIT.")
      .optional()
      .refine(
        (value: string | undefined): boolean => value === undefined || !SQL_CLAUSES_IN_ORDER_BY_REGEX.test(value),
        "orderBy must contain only column names and ASC/DESC direction.",
      ),
    limit: z.number()
      .int()
      .min(1)
      .max(50)
      .describe("Maximum number of rows to return (default from BLACKDOGBOT_READ_DB_DEFAULT_LIMIT or 20, max 50)")
      .optional(),
    offset: z.number()
      .int()
      .min(0)
      .describe("Zero-based row offset for pagination (default 0)")
      .optional(),
    columns: z.string()
      .regex(IDENTIFIER_REGEX, "Column names must be plain identifiers")
      .array()
      .min(1)
      .describe("Specific columns to select (defaults to all columns)")
      .optional(),
  }).strict();

  return dynamicTool({
    description: "Read rows from a table in the default database with optional filtering, ordering, and column selection",
    inputSchema,
    execute: async (input: unknown): Promise<{
      tableName: string;
      rows: Record<string, unknown>[];
      matchingTotal: number;
      returnedCount: number;
      offset: number;
      limit: number;
      remainingCount: number;
      nextOffset: number | null;
      continuationHint: string;
    }> => {
      const validatedInput = inputSchema.parse(input);
      const {
        tableName,
        where,
        orderBy,
        limit,
        offset,
        columns,
      } = validatedInput;

      const effectiveLimit: number = limit ?? _DefaultReadDbLimit;
      const effectiveOffset: number = offset ?? 0;

      const dbExists: boolean = await litesql.databaseExistsAsync(DEFAULT_DATABASE);
      if (!dbExists) {
        throw new Error(
          "Internal database is not initialized.",
        );
      }

      const tableExists: boolean = await litesql.tableExistsAsync(DEFAULT_DATABASE, tableName);
      if (!tableExists) {
        const allTables: string[] = await litesql.listTablesAsync(DEFAULT_DATABASE);
        const available: string = allTables.join(", ") || "(none)";

        throw new Error(
          `Table "${tableName}" does not exist in database "${DEFAULT_DATABASE}".\n` +
            `Available tables: ${available}`,
        );
      }

      if (columns !== undefined && columns.length > 0) {
        const schema = await litesql.getTableSchemaAsync(DEFAULT_DATABASE, tableName);
        const validColumnNames: Set<string> = new Set(schema.columns.map((column) => column.name));
        const invalidColumns: string[] = columns.filter((columnName: string): boolean => !validColumnNames.has(columnName));

        if (invalidColumns.length > 0) {
          throw new Error(
            `Unknown columns requested: ${invalidColumns.join(", ")}. ` +
              `Available columns in "${tableName}": ${Array.from(validColumnNames).join(", ")}`,
          );
        }
      }

      const result: IQueryResult = await litesql.queryTableAsync(DEFAULT_DATABASE, tableName, {
        where,
        orderBy,
        limit: effectiveLimit,
        offset: effectiveOffset,
        columns,
      });

      const returnedCount: number = result.rows.length;
      const matchingTotal: number = result.totalCount;
      const consumedCount: number = effectiveOffset + returnedCount;
      const remainingCount: number = Math.max(0, matchingTotal - consumedCount);
      const nextOffset: number | null = remainingCount > 0 ? consumedCount : null;
      const continuationHint: string =
        nextOffset === null
          ? `${returnedCount} items read, 0 remaining within current constraints.`
          : `${returnedCount} items read, ${remainingCount} remaining within current constraints. Use offset=${nextOffset} to continue.`;

      return {
        tableName,
        rows: result.rows,
        matchingTotal,
        returnedCount,
        offset: effectiveOffset,
        limit: effectiveLimit,
        remainingCount,
        nextOffset,
        continuationHint,
      };
    },
  });
}

// Fallback tool instance used before runtime table discovery.
export const readFromDatabaseTool = buildReadFromDatabaseTool([]);
