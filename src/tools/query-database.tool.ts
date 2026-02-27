import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService, type IQueryResult } from "../services/litesql.service.js";
import { LoggerService } from "../services/logger.service.js";

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
  data: z.record(z.unknown())
    .optional()
    .describe("Data to insert as a single row object for insert action (e.g. {title: 'Hello', score: 5})"),
  set: z.record(z.unknown())
    .optional()
    .describe("Column-value pairs to set for update action (e.g. {isInteresting: 1, score: 10})"),
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

export const queryDatabaseTool = tool({
  description: "Unified database query tool with action-based interface for listing databases, tables, querying table data, inserting, updating, deleting rows, and showing table schemas",
  inputSchema,
  execute: async (input: QueryDatabaseInput): Promise<IQueryDatabaseResult> => {
    const service: LiteSqlService = LiteSqlService.getInstance();
    const logger: LoggerService = LoggerService.getInstance();

    try {
      switch (input.action) {
        case "list_databases":
          return await _handleListDatabasesAsync(service);

        case "list_tables":
          return await _handleListTablesAsync(service, input.databaseName);

        case "query_table":
          return await _handleQueryTableAsync(
            service,
            input.databaseName,
            input.tableName,
            input.where,
            input.orderBy,
            input.limit,
            input.columns,
          );

        case "show_schema":
          return await _handleShowSchemaAsync(service, input.databaseName, input.tableName);

        case "insert":
          return await _handleInsertAsync(
            service,
            input.databaseName,
            input.tableName,
            input.data,
          );

        case "update":
          return await _handleUpdateAsync(
            service,
            input.databaseName,
            input.tableName,
            input.set,
            input.where,
          );

        case "delete":
          return await _handleDeleteAsync(
            service,
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("query-database tool error", { error: errorMsg });
      return {
        success: false,
        action: input.action,
        error: errorMsg,
      };
    }
  },
});

async function _handleListDatabasesAsync(service: LiteSqlService): Promise<IQueryDatabaseResult> {
  const databases = await service.listDatabasesAsync();

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
  service: LiteSqlService,
  databaseName?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "list_tables",
      error: `databaseName is required for list_tables action.\nAvailable databases: ${available}`,
    };
  }

  const exists: boolean = await service.databaseExistsAsync(databaseName);
  if (!exists) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "list_tables",
      error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
    };
  }

  const tables: string[] = await service.listTablesAsync(databaseName);

  return {
    success: true,
    action: "list_tables",
    databaseName,
    tables,
  };
}

async function _handleQueryTableAsync(
  service: LiteSqlService,
  databaseName?: string,
  tableName?: string,
  where?: string,
  orderBy?: string,
  limit?: number,
  columns?: string[],
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "query_table",
      error: `databaseName is required for query_table action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

    return {
      success: false,
      action: "query_table",
      error: `tableName is required for query_table action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  const dbExists: boolean = await service.databaseExistsAsync(databaseName);
  if (!dbExists) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "query_table",
      error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
    };
  }

  const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
  if (!tableExists) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

    return {
      success: false,
      action: "query_table",
      error: `Table "${tableName}" does not exist in database "${databaseName}".\nAvailable tables: ${available}`,
    };
  }

  const result: IQueryResult = await service.queryTableAsync(databaseName, tableName, {
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
  service: LiteSqlService,
  databaseName?: string,
  tableName?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "show_schema",
      error: `databaseName is required for show_schema action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

    return {
      success: false,
      action: "show_schema",
      error: `tableName is required for show_schema action.\nAvailable tables in "${databaseName}": ${available}`,
    };
  }

  const dbExists: boolean = await service.databaseExistsAsync(databaseName);
  if (!dbExists) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "show_schema",
      error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
    };
  }

  const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
  if (!tableExists) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

    return {
      success: false,
      action: "show_schema",
      error: `Table "${tableName}" does not exist in database "${databaseName}".\nAvailable tables: ${available}`,
    };
  }

  const schema = await service.getTableSchemaAsync(databaseName, tableName);

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
  service: LiteSqlService,
  databaseName?: string,
  tableName?: string,
  data?: Record<string, unknown>,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "insert",
      error: `databaseName is required for insert action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

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

  const dbExists: boolean = await service.databaseExistsAsync(databaseName);
  if (!dbExists) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "insert",
      error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
    };
  }

  const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName);
  if (!tableExists) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

    return {
      success: false,
      action: "insert",
      error: `Table "${tableName}" does not exist in database "${databaseName}".\nAvailable tables: ${available}`,
    };
  }

  const result = await service.insertIntoTableAsync(databaseName, tableName, data);

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
  service: LiteSqlService,
  databaseName?: string,
  tableName?: string,
  set?: Record<string, unknown>,
  where?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "update",
      error: `databaseName is required for update action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

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

  const dbExists: boolean = await service.databaseExistsAsync(databaseName);
  if (!dbExists) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "update",
      error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
    };
  }

  const result = await service.updateTableAsync(databaseName, tableName, set, where);

  return {
    success: true,
    action: "update",
    databaseName,
    tableName,
    updatedCount: result.updatedCount,
  };
}

async function _handleDeleteAsync(
  service: LiteSqlService,
  databaseName?: string,
  tableName?: string,
  where?: string,
): Promise<IQueryDatabaseResult> {
  if (!databaseName) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "delete",
      error: `databaseName is required for delete action.\nAvailable databases: ${available}`,
    };
  }

  if (!tableName) {
    const allTables: string[] = await service.listTablesAsync(databaseName);
    const available: string = allTables.join(", ") || "(none)";

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

  const dbExists: boolean = await service.databaseExistsAsync(databaseName);
  if (!dbExists) {
    const allDbs = await service.listDatabasesAsync();
    const available: string = allDbs.map((d) => d.name).join(", ") || "(none)";

    return {
      success: false,
      action: "delete",
      error: `Database "${databaseName}" does not exist.\nAvailable databases: ${available}`,
    };
  }

  const result = await service.deleteFromTableAsync(databaseName, tableName, where);

  return {
    success: true,
    action: "delete",
    databaseName,
    tableName,
    deletedCount: result.deletedCount,
  };
}
