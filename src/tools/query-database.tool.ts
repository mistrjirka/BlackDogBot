import { tool } from "ai";
import { z } from "zod";

import { LiteSqlService, type IQueryResult } from "../services/litesql.service.js";

const actionSchema = z.enum(["list_databases", "list_tables", "query_table", "show_schema"]);

const inputSchema = z.object({
  action: actionSchema
    .describe("The action to perform"),
  databaseName: z.string()
    .optional()
    .describe("Database name (required for list_tables, query_table, show_schema)"),
  tableName: z.string()
    .optional()
    .describe("Table name (required for query_table, show_schema)"),
  where: z.string()
    .optional()
    .describe("SQL WHERE clause for query_table (e.g. \"isInteresting = 1 AND pubDate > '2024-01-01'\")"),
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
  error?: string;
}

export const queryDatabaseTool = tool({
  description: "Unified database query tool with action-based interface for listing databases, tables, querying table data, and showing table schemas",
  inputSchema,
  execute: async (input: QueryDatabaseInput): Promise<IQueryDatabaseResult> => {
    const service: LiteSqlService = LiteSqlService.getInstance();

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

        default:
          return {
            success: false,
            action: input.action,
            error: `Unknown action: ${input.action}`,
          };
      }
    } catch (error: unknown) {
      return {
        success: false,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
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
