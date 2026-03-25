import { tool } from "langchain";
import { z } from "zod";

import * as litesql from "../helpers/litesql.js";
import * as litesqlValidation from "../helpers/litesql-validation.js";
import type { IQueryResult } from "../helpers/litesql.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

const actionSchema = z.enum([
  "list_databases",
  "list_tables",
  "query_table",
  "show_schema",
  "insert",
  "update",
  "delete",
]);

const inputSchema = z.object({
  action: actionSchema
    .describe("The action to perform: list_databases, list_tables, query_table (SELECT), show_schema, insert, update, delete"),
  databaseName: z.string()
    .optional()
    .describe("Database name (required for list_tables, query_table, show_schema, insert, update, delete)"),
  tableName: z.string()
    .optional()
    .describe("Table name (required for query_table, show_schema, insert, update, delete)"),
  where: z.string()
    .optional()
    .describe("SQL WHERE clause for query_table, update, or delete (e.g. \"isInteresting = 1 AND pubDate > '2024-01-01'\"). Required for update and delete."),
  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Maximum rows to return for query_table (default 100)"),
  orderBy: z.string()
    .optional()
    .describe("SQL ORDER BY clause for query_table (e.g. \"pubDate DESC\")"),
  columns: z.string()
    .array()
    .optional()
    .describe("Specific columns to select for query_table (defaults to all)"),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Data to insert as a single row object for insert action (e.g. {title: 'Hello', score: 5}). Values must be flat primitives — no nested objects."),
  set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Column-value pairs to set for update action (e.g. {isInteresting: 1, score: 10}). Values must be flat primitives — no nested objects."),
});

type QueryDatabaseInput = z.infer<typeof inputSchema>;

interface IDatabaseInfo {
  name: string;
  tableCount: number;
  sizeBytes: number;
  createdAt: string;
}

interface IColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

interface ITableSchema {
  name: string;
  columns: IColumnInfo[];
}

interface IQueryDatabaseResult {
  success: boolean;
  action: string;
  databases?: IDatabaseInfo[];
  databaseName?: string;
  tables?: string[];
  tableName?: string;
  rows?: Record<string, unknown>[];
  totalCount?: number;
  returnedCount?: number;
  schema?: ITableSchema;
  insertedCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  lastRowId?: number;
  error?: string;
}

export const queryDatabaseTool = tool(
  async (input: QueryDatabaseInput): Promise<IQueryDatabaseResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      switch (input.action) {
        case "list_databases":
          return await _handleListDatabasesAsync();

        case "list_tables":
          return await _handleListTablesAsync(input.databaseName);

        case "query_table":
          return await _handleQueryTableAsync(
            input.databaseName,
            input.tableName,
            input.where,
            input.orderBy,
            input.limit,
            input.columns,
          );

        case "show_schema":
          return await _handleShowSchemaAsync(input.databaseName, input.tableName);

        case "insert":
          return await _handleInsertAsync(
            input.databaseName,
            input.tableName,
            input.data,
          );

        case "update":
          return await _handleUpdateAsync(
            input.databaseName,
            input.tableName,
            input.set,
            input.where,
          );

        case "delete":
          return await _handleDeleteAsync(
            input.databaseName,
            input.tableName,
            input.where,
          );

        default:
          return {
            success: false,
            action: input.action,
            error: `Unknown action: ${input.action}`,
          };
      }
    } catch (error: unknown) {
      const errorMsg = extractErrorMessage(error);
      logger.error("query-database tool error", { error: errorMsg });
      return {
        success: false,
        action: input.action,
        error: errorMsg,
      };
    }
  },
  {
    name: "query_database",
    description: "Unified database query tool with action-based interface for listing databases, tables, querying table data, inserting, updating, deleting rows, and showing table schemas",
    schema: inputSchema,
  },
);

async function _handleListDatabasesAsync(): Promise<IQueryDatabaseResult> {
  const databases = await litesql.listDatabasesAsync();

  return {
    success: true,
    action: "list_databases",
    databases: databases.map((db) => ({
      name: db.name,
      tableCount: db.tableCount,
      sizeBytes: db.sizeBytes,
      createdAt: db.createdAt,
    })),
  };
}

async function _handleListTablesAsync(
  databaseName?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const available = await litesqlValidation.getAvailableDatabasesAsync();

    return {
      success: false,
      action: "list_tables",
      error: `databaseName is required for list_tables action.\nAvailable databases: ${available}`,
    };
  }

  try {
    await litesqlValidation.validateDatabaseExistsAsync(databaseName);
  } catch (error: unknown) {
    return {
      success: false,
      action: "list_tables",
      error: extractErrorMessage(error),
    };
  }

  const tables: string[] = await litesql.listTablesAsync(databaseName);

  return {
    success: true,
    action: "list_tables",
    databaseName,
    tables,
  };
}

async function _handleQueryTableAsync(
  databaseName?: string,
  tableName?: string,
  where?: string,
  orderBy?: string,
  limit?: number,
  columns?: string[],
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const available = await litesqlValidation.getAvailableDatabasesAsync();

    return {
      success: false,
      action: "query_table",
      error: `databaseName is required for query_table action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const available = await litesqlValidation.getAvailableTablesAsync(databaseName);

    return {
      success: false,
      action: "query_table",
      error: `tableName is required for query_table action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  try {
    await litesqlValidation.validateTableExistsAsync(databaseName, tableName);
  } catch (error: unknown) {
    return {
      success: false,
      action: "query_table",
      error: extractErrorMessage(error),
    };
  }

  const result: IQueryResult = await litesql.queryTableAsync(databaseName, tableName, {
    where,
    orderBy,
    limit: limit ?? 100,
    columns,
  });

  return {
    success: true,
    action: "query_table",
    databaseName,
    tableName,
    rows: result.rows,
    totalCount: result.totalCount,
    returnedCount: result.rows.length,
  };
}

async function _handleShowSchemaAsync(
  databaseName?: string,
  tableName?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const available = await litesqlValidation.getAvailableDatabasesAsync();

    return {
      success: false,
      action: "show_schema",
      error: `databaseName is required for show_schema action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const available = await litesqlValidation.getAvailableTablesAsync(databaseName);

    return {
      success: false,
      action: "show_schema",
      error: `tableName is required for show_schema action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  try {
    await litesqlValidation.validateTableExistsAsync(databaseName, tableName);
  } catch (error: unknown) {
    return {
      success: false,
      action: "show_schema",
      error: extractErrorMessage(error),
    };
  }

  const schema = await litesql.getTableSchemaAsync(databaseName, tableName);

  return {
    success: true,
    action: "show_schema",
    databaseName,
    schema: {
      name: schema.name,
      columns: schema.columns,
    },
  };
}

async function _handleInsertAsync(
  databaseName?: string,
  tableName?: string,
  data?: Record<string, unknown>,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const available = await litesqlValidation.getAvailableDatabasesAsync();

    return {
      success: false,
      action: "insert",
      error: `databaseName is required for insert action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const available = await litesqlValidation.getAvailableTablesAsync(databaseName);

    return {
      success: false,
      action: "insert",
      error: `tableName is required for insert action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  if (!data || Object.keys(data).length === 0) {
    return {
      success: false,
      action: "insert",
      error: "data is required for insert action (e.g. {title: 'Hello', score: 5})",
    };
  }

  try {
    await litesqlValidation.validateTableExistsAsync(databaseName, tableName);
  } catch (error: unknown) {
    return {
      success: false,
      action: "insert",
      error: extractErrorMessage(error),
    };
  }

  const result = await litesql.insertIntoTableAsync(databaseName, tableName, data);

  return {
    success: true,
    action: "insert",
    databaseName,
    tableName,
    insertedCount: result.insertedCount,
    lastRowId: result.lastRowId,
  };
}

async function _handleUpdateAsync(
  databaseName?: string,
  tableName?: string,
  set?: Record<string, unknown>,
  where?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const available = await litesqlValidation.getAvailableDatabasesAsync();

    return {
      success: false,
      action: "update",
      error: `databaseName is required for update action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const available = await litesqlValidation.getAvailableTablesAsync(databaseName);

    return {
      success: false,
      action: "update",
      error: `tableName is required for update action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  if (!set || Object.keys(set).length === 0) {
    return {
      success: false,
      action: "update",
      error: "set is required for update action (e.g. {isInteresting: 1, score: 10})",
    };
  }

  if (!where) {
    return {
      success: false,
      action: "update",
      error: "where is required for update action to prevent accidental full-table updates (e.g. \"id = 5\")",
    };
  }

  try {
    await litesqlValidation.validateTableExistsAsync(databaseName, tableName);
  } catch (error: unknown) {
    return {
      success: false,
      action: "update",
      error: extractErrorMessage(error),
    };
  }

  const result = await litesql.updateTableAsync(databaseName, tableName, set, where);

  return {
    success: true,
    action: "update",
    databaseName,
    tableName,
    updatedCount: result.updatedCount,
  };
}

async function _handleDeleteAsync(
  databaseName?: string,
  tableName?: string,
  where?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const available = await litesqlValidation.getAvailableDatabasesAsync();

    return {
      success: false,
      action: "delete",
      error: `databaseName is required for delete action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const available = await litesqlValidation.getAvailableTablesAsync(databaseName);

    return {
      success: false,
      action: "delete",
      error: `tableName is required for delete action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  if (!where) {
    return {
      success: false,
      action: "delete",
      error: "where is required for delete action to prevent accidental full-table deletes (e.g. \"id < 10\")",
    };
  }

  try {
    await litesqlValidation.validateTableExistsAsync(databaseName, tableName);
  } catch (error: unknown) {
    return {
      success: false,
      action: "delete",
      error: extractErrorMessage(error),
    };
  }

  const result = await litesql.deleteFromTableAsync(databaseName, tableName, where);

  return {
    success: true,
    action: "delete",
    databaseName,
    tableName,
    deletedCount: result.deletedCount,
  };
}
