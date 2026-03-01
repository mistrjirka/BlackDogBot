import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { LiteSqlService } from "../../../src/services/litesql.service.js";
import { createTableTool } from "../../../src/tools/create-table.tool.js";
import { createAddLitesqlNodeTool } from "../../../src/tools/add-litesql-node.tool.js";
import { JobActivityTracker } from "../../../src/utils/job-activity-tracker.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (ConfigService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
  (LiteSqlService as unknown as { _instance: null })._instance = null;
}

async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".betterclaw");
  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, path.join(tempConfigDir, "config.yaml"));
  await configService.initializeAsync(path.join(tempConfigDir, "config.yaml"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execTool<T>(toolObj: any, args: unknown): Promise<T> {
  if (!toolObj.execute) {
    throw new Error("Tool has no execute function");
  }

  const result = await toolObj.execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );

  return result as T;
}

//#endregion Helpers

//#region Tests

describe("LITESQL node schema enforcement", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-litesql-enforcement-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();
    await initServicesAsync();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("FAILS if table doesn't exist and no inputSchemaHint provided", async () => {
    // Arrange — create a job but no database/table
    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("NoTableJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    // Act — try to add LITESQL node for non-existent database/table
    const result = await execTool<{ success: boolean; error?: string; message: string; nodeId: string }>(
      addLitesqlNodeTool,
      {
        jobId: job.jobId,
        name: "TestNode",
        description: "test",
        outputSchema: {},
        databaseName: "nonexistentdb",
        tableName: "nonexistent_table",
        // NO inputSchemaHint
      },
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error ?? result.message).toContain("nonexistent_table");
    expect(result.error ?? result.message).toContain("create_table");
  });

  it("PASSES and auto-derives schema if table exists and no hint provided", async () => {
    // Arrange — create database and table first
    const liteSqlService: LiteSqlService = LiteSqlService.getInstance();
    await liteSqlService.createDatabaseAsync("testdb");
    await liteSqlService.createTableAsync("testdb", "articles", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "url", type: "TEXT", notNull: false },
    ]);

    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("AutoDeriveJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    // Act — add node WITHOUT hint — table exists so should auto-derive
    const result = await execTool<{ success: boolean; error?: string; message: string; nodeId: string; warning?: string }>(
      addLitesqlNodeTool,
      {
        jobId: job.jobId,
        name: "ArticleNode",
        description: "writes articles",
        outputSchema: {},
        databaseName: "testdb",
        tableName: "articles",
        // No inputSchemaHint
      },
    );

    // Assert
    expect(result.success).toBe(true);
    expect(result.nodeId).toBeTruthy();

    // Verify the node's inputSchema was derived from the table
    const node = await storageService.getNodeAsync(job.jobId, result.nodeId);
    expect(node).toBeTruthy();
    expect(node!.inputSchema).toBeDefined();
    expect((node!.inputSchema as Record<string, unknown>).properties).toBeDefined();

    const props = (node!.inputSchema as { properties: Record<string, unknown> }).properties;
    // id is primary key — should be excluded
    expect(props).not.toHaveProperty("id");
    // title and url should be included
    expect(props).toHaveProperty("title");
    expect(props).toHaveProperty("url");

    // title is NOT NULL so should be in required
    const required = (node!.inputSchema as { required: string[] }).required;
    expect(required).toContain("title");
  });

  it("PASSES if table doesn't exist but inputSchemaHint is provided", async () => {
    // Arrange — create job; table does NOT exist yet
    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("HintJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    const schemaHint = {
      type: "object",
      properties: {
        title: { type: "string" },
        score: { type: "number" },
      },
      required: ["title"],
    };

    // Act — add node with hint (table doesn't exist but hint is provided)
    const result = await execTool<{ success: boolean; error?: string; message: string; nodeId: string }>(
      addLitesqlNodeTool,
      {
        jobId: job.jobId,
        name: "HintNode",
        description: "uses schema hint",
        outputSchema: {},
        databaseName: "futuredb",
        tableName: "future_table",
        inputSchemaHint: schemaHint,
      },
    );

    // Assert
    expect(result.success).toBe(true);
    expect(result.nodeId).toBeTruthy();

    // Verify the node uses the hint as its inputSchema
    const node = await storageService.getNodeAsync(job.jobId, result.nodeId);
    expect(node).toBeTruthy();
    expect(node!.inputSchema).toMatchObject(schemaHint);
  });

  it("PASSES and warns when inputSchemaHint doesn't match actual table schema", async () => {
    // Arrange — create database and table with title NOT NULL
    const liteSqlService: LiteSqlService = LiteSqlService.getInstance();
    await liteSqlService.createDatabaseAsync("warndb");
    await liteSqlService.createTableAsync("warndb", "news", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "url", type: "TEXT", notNull: false },
    ]);

    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("WarnJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    // Provide a WRONG schema hint — missing 'title' required column
    const wrongHint = {
      type: "object",
      properties: {
        wrong_column: { type: "string" },
      },
      required: ["wrong_column"],
    };

    // Act
    const result = await execTool<{ success: boolean; error?: string; message: string; nodeId: string; warning?: string }>(
      addLitesqlNodeTool,
      {
        jobId: job.jobId,
        name: "WarnNode",
        description: "wrong schema hint",
        outputSchema: {},
        databaseName: "warndb",
        tableName: "news",
        inputSchemaHint: wrongHint,
      },
    );

    // Assert — should succeed but warn about mismatch
    expect(result.success).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("Schema mismatch");
    expect(result.warning).toContain("title");
  });

  it("create_table returns inputSchema that can be used as inputSchemaHint", async () => {
    // Arrange — create database first
    const liteSqlService: LiteSqlService = LiteSqlService.getInstance();
    await liteSqlService.createDatabaseAsync("schemadb");

    // Act — call create_table and capture its output
    const createResult = await execTool<{
      success: boolean;
      inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
      columns: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean; defaultValue: string | null }>;
      message: string;
    }>(
      createTableTool,
      {
        databaseName: "schemadb",
        tableName: "products",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true, notNull: false },
          { name: "name", type: "TEXT", notNull: true },
          { name: "price", type: "REAL", notNull: true },
          { name: "notes", type: "TEXT", notNull: false },
        ],
      },
    );

    expect(createResult.success).toBe(true);
    expect(createResult.inputSchema).toBeDefined();
    expect(createResult.inputSchema.type).toBe("object");
    expect(createResult.inputSchema.properties).toHaveProperty("name");
    expect(createResult.inputSchema.properties).toHaveProperty("price");
    expect(createResult.inputSchema.properties).toHaveProperty("notes");
    // id is primary key — should NOT be in properties
    expect(createResult.inputSchema.properties).not.toHaveProperty("id");
    // name and price are NOT NULL so should be required
    expect(createResult.inputSchema.required).toContain("name");
    expect(createResult.inputSchema.required).toContain("price");
    // notes is nullable so should NOT be required
    expect(createResult.inputSchema.required).not.toContain("notes");

    // Also verify message contains schema hint
    expect(createResult.message).toContain("inputSchemaHint");

    // Verify type mappings
    expect((createResult.inputSchema.properties.name as Record<string, unknown>).type).toBe("string");
    expect((createResult.inputSchema.properties.price as Record<string, unknown>).type).toBe("number");
  });
});

//#endregion Tests
