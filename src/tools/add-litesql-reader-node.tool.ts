import { tool } from "ai";
import { addLitesqlReaderNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { ILiteSqlReaderConfig, IJob, INode } from "../shared/types/index.js";
import { LiteSqlService, ITableInfo } from "../services/litesql.service.js";
import { deriveOutputSchemaFromTable } from "../utils/litesql-schema-helper.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

export function createAddLitesqlReaderNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add a litesql_reader node to a job in job creation mode. This node reads rows from a " +
      "SQLite table and outputs { rows: [...], totalCount: number }. Supports WHERE filtering " +
      "(with {{key}} template substitution), ORDER BY, and LIMIT. The output schema is " +
      "auto-derived from the table columns. The table MUST exist before adding this node.",
    inputSchema: addLitesqlReaderNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      databaseName,
      tableName,
      where,
      orderBy,
      limit,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema?: Record<string, unknown>;
      databaseName: string;
      tableName: string;
      where: string | null;
      orderBy: string | null;
      limit: number | null;
    }): Promise<ICreateNodeResult & { derivedOutputSchema?: Record<string, unknown>; graphAscii?: string }> => {
      try {
        const service: LiteSqlService = LiteSqlService.getInstance();

        const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName).catch(() => false);
        if (!tableExists) {
          return {
            nodeId: "",
            success: false,
            message:
              `Table '${tableName}' doesn't exist in database '${databaseName}'. ` +
              `Create it first with create_table.`,
            error:
              `Table '${tableName}' doesn't exist in database '${databaseName}'. ` +
              `Create it first with create_table.`,
          };
        }

        const tableInfo: ITableInfo = await service.getTableSchemaAsync(databaseName, tableName);
        const derivedOutputSchema: Record<string, unknown> = deriveOutputSchemaFromTable(tableInfo);

        // The node accepts any input (used for template substitution in WHERE)
        const inputSchema: Record<string, unknown> = {
          type: "object",
          properties: {},
          additionalProperties: true,
        };

        const config: ILiteSqlReaderConfig = { databaseName, tableName, where, orderBy, limit };
        const effectiveOutputSchema: Record<string, unknown> = outputSchema ?? derivedOutputSchema;

        const result: ICreateNodeResult = await createNodeAsync(
          jobId,
          "litesql_reader",
          name,
          description,
          inputSchema,
          effectiveOutputSchema,
          config,
          parentNodeId,
          jobTracker,
        );
        if (!result.success) {
          return result;
        }

        const storage: JobStorageService = JobStorageService.getInstance();
        const updatedJob: IJob | null = await storage.getJobAsync(jobId);
        const nodes: INode[] = await storage.listNodesAsync(jobId);
        const graphAscii: string = buildAsciiGraph(nodes, updatedJob?.entrypointNodeId ?? null);

        return { ...result, derivedOutputSchema, graphAscii };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
