import { tool } from "ai";
import { addLitesqlNodeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { type IJobActivityTracker } from "../utils/job-activity-tracker.js";
import { createNodeAsync, type ICreateNodeResult } from "../utils/node-creation-helper.js";
import { ILiteSqlConfig, IJob, INode } from "../shared/types/index.js";
import { LiteSqlService, ITableInfo } from "../services/litesql.service.js";
import { deriveInputSchemaFromTable, validateSchemaHintAgainstTable, IJsonSchema } from "../utils/litesql-schema-helper.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { buildAsciiGraph } from "../utils/ascii-graph.js";

// Default output schema for litesql nodes - they return insert metadata, not the data itself
const LITESQL_DEFAULT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    insertedCount: {
      type: "number",
      description: "Number of rows inserted",
    },
    lastRowId: {
      type: "number",
      description: "The rowid of the last inserted row",
    },
  },
  required: ["insertedCount", "lastRowId"],
};

export function createAddLitesqlNodeTool(jobTracker: IJobActivityTracker) {
  return tool({
    description:
      "Add a litesql node to a job in job creation mode. The node writes its input data to a " +
      "LiteSQL table. Use parentNodeId to automatically connect the parent node to this one. " +
      "The node outputs { insertedCount: number, lastRowId: number } - the count of inserted rows " +
      "and the last row ID. If outputSchema is not provided, this default output schema is used. " +
      "IMPORTANT: If the table already exists, the inputSchema will be auto-derived. " +
      "If the table does NOT exist yet, you MUST provide inputSchemaHint from the create_table output.",
    inputSchema: addLitesqlNodeToolInputSchema,
    execute: async ({
      jobId,
      parentNodeId,
      name,
      description,
      outputSchema,
      databaseName,
      tableName,
      inputSchemaHint,
    }: {
      jobId: string;
      parentNodeId?: string;
      name: string;
      description: string;
      outputSchema?: Record<string, unknown>;
      databaseName: string;
      tableName: string;
      inputSchemaHint?: Record<string, unknown>;
    }): Promise<ICreateNodeResult & { warning?: string; graphAscii?: string }> => {
      try {
        const service: LiteSqlService = LiteSqlService.getInstance();
        let effectiveInputSchema: Record<string, unknown>;
        let warning: string | undefined;

        const tableExists: boolean = await service.tableExistsAsync(databaseName, tableName).catch(() => false);

        if (tableExists) {
          // Table exists: auto-derive schema from actual table
          const tableInfo: ITableInfo = await service.getTableSchemaAsync(databaseName, tableName);
          const derivedSchema: IJsonSchema = deriveInputSchemaFromTable(tableInfo);
          effectiveInputSchema = derivedSchema as unknown as Record<string, unknown>;

          // If caller also provided a hint, warn on mismatch but still use table schema
          if (inputSchemaHint) {
            const warnings: string[] = validateSchemaHintAgainstTable(inputSchemaHint, tableInfo);
            if (warnings.length > 0) {
              warning = warnings.join(" ");
            }
          }
        } else if (inputSchemaHint) {
          // Table doesn't exist yet but hint was provided: use hint
          effectiveInputSchema = inputSchemaHint;
        } else {
          // Table doesn't exist AND no hint: ERROR
          return {
            nodeId: "",
            success: false,
            message:
              `Table '${tableName}' doesn't exist in database '${databaseName}'. ` +
              `Create it first with create_table, then provide inputSchemaHint from its output.`,
            error:
              `Table '${tableName}' doesn't exist in database '${databaseName}'. ` +
              `Create it first with create_table, then provide inputSchemaHint from its output.`,
          };
        }

        const config: ILiteSqlConfig = { databaseName, tableName };

        // Use the provided outputSchema or fall back to the default
        const effectiveOutputSchema: Record<string, unknown> = outputSchema ?? LITESQL_DEFAULT_OUTPUT_SCHEMA;

        const result: ICreateNodeResult = await createNodeAsync(
          jobId,
          "litesql",
          name,
          description,
          effectiveInputSchema,
          effectiveOutputSchema,
          config,
          parentNodeId,
          jobTracker,
        );
        if (!result.success) {
          return { ...result, warning };
        }

        const storage: JobStorageService = JobStorageService.getInstance();
        const updatedJob: IJob | null = await storage.getJobAsync(jobId);
        const nodes: INode[] = await storage.listNodesAsync(jobId);
        const graphAscii: string = buildAsciiGraph(nodes, updatedJob?.entrypointNodeId ?? null);

        return { ...result, warning, graphAscii };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);

        return { nodeId: "", success: false, message: errorMessage, error: errorMessage };
      }
    },
  });
}
