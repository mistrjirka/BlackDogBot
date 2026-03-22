import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import * as litesql from "../../../src/helpers/litesql.js";
import { createTableTool } from "../../../src/tools/create-table.tool.js";
import { createAddLitesqlNodeTool } from "../../../src/tools/add-litesql-node.tool.js";
import { JobActivityTracker } from "../../../src/utils/job-activity-tracker.js";


let tempDir: string;
let originalHome: string;


async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  const sharedLogDir: string = path.join(os.tmpdir(), "blackdogbot-test-logs");
  await fs.mkdir(sharedLogDir, { recursive: true });
  await loggerService.initializeAsync("error", sharedLogDir);

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, path.join(tempConfigDir, "config.yaml"));
  await configService.initializeAsync(path.join(tempConfigDir, "config.yaml"));
}

async function execTool<T>(toolObj: unknown, args: unknown): Promise<T> {
  if (!(toolObj as { execute?: unknown }).execute) {
    throw new Error("Tool has no execute function");
  }

  const result = await (toolObj as { execute: (args: unknown, context: unknown) => Promise<T> }).execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );

  return result as T;
}


//#region Tests

describe("LITESQL node schema enforcement", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-litesql-enforcement-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();
    await initServicesAsync();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("FAILS if table doesn't exist and no inputSchemaHint provided", async () => {
    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("NoTableJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    const result = await execTool<{ success: boolean; error?: string; message: string; nodeId: string }>(
      addLitesqlNodeTool,
      {
        jobId: job.jobId,
        name: "TestNode",
        description: "test",
        outputSchema: {},
        databaseName: "nonexistentdb",
        tableName: "nonexistent_table",
      },
    );

    expect(result.success).toBe(false);
    expect(result.error ?? result.message).toContain("nonexistent_table");
    expect(result.error ?? result.message).toContain("create_table");
  });

  it("PASSES and auto-derives schema if table exists and no hint provided", async () => {
    await litesql.createDatabaseAsync("testdb");
    await litesql.createTableAsync("testdb", "articles", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "url", type: "TEXT", notNull: false },
    ]);

    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("AutoDeriveJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    const result = await execTool<{ success: boolean; error?: string; message: string; nodeId: string; warning?: string }>(
      addLitesqlNodeTool,
      {
        jobId: job.jobId,
        name: "ArticleNode",
        description: "writes articles",
        outputSchema: {},
        databaseName: "testdb",
        tableName: "articles",
      },
    );

    expect(result.success).toBe(true);
    expect(result.nodeId).toBeTruthy();

    const node = await storageService.getNodeAsync(job.jobId, result.nodeId);
    expect(node).toBeTruthy();
    expect(node!.inputSchema).toBeDefined();
    expect((node!.inputSchema as Record<string, unknown>).properties).toBeDefined();

    const props = (node!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("id");
    expect(props).toHaveProperty("title");
    expect(props).toHaveProperty("url");

    const required = (node!.inputSchema as { required: string[] }).required;
    expect(required).toContain("title");
  });

  it("PASSES if table doesn't exist but inputSchemaHint is provided", async () => {
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

    expect(result.success).toBe(true);
    expect(result.nodeId).toBeTruthy();

    const node = await storageService.getNodeAsync(job.jobId, result.nodeId);
    expect(node).toBeTruthy();
    expect(node!.inputSchema).toMatchObject(schemaHint);
  });

  it("PASSES and warns when inputSchemaHint doesn't match actual table schema", async () => {
    await litesql.createDatabaseAsync("warndb");
    await litesql.createTableAsync("warndb", "news", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "url", type: "TEXT", notNull: false },
    ]);

    const storageService: JobStorageService = JobStorageService.getInstance();
    const job = await storageService.createJobAsync("WarnJob", "test");
    const jobTracker: JobActivityTracker = new JobActivityTracker();
    const addLitesqlNodeTool = createAddLitesqlNodeTool(jobTracker);

    const wrongHint = {
      type: "object",
      properties: {
        wrong_column: { type: "string" },
      },
      required: ["wrong_column"],
    };

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

    expect(result.success).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("Schema mismatch");
    expect(result.warning).toContain("title");
  });

  it("create_table returns inputSchema that can be used as inputSchemaHint", async () => {
    await litesql.createDatabaseAsync("schemadb");

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
    expect(createResult.inputSchema.properties).not.toHaveProperty("id");
    expect(createResult.inputSchema.required).toContain("name");
    expect(createResult.inputSchema.required).toContain("price");
    expect(createResult.inputSchema.required).not.toContain("notes");

    expect(createResult.message).toContain("inputSchemaHint");

    expect((createResult.inputSchema.properties.name as Record<string, unknown>).type).toBe("string");
    expect((createResult.inputSchema.properties.price as Record<string, unknown>).type).toBe("number");
  });
});

//#endregion Tests
