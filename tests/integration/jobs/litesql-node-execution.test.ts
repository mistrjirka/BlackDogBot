import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import { LiteSqlService } from "../../../src/services/litesql.service.js";
import { JobExecutorService } from "../../../src/services/job-executor.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (LoggerService as unknown as { _instance: null })._instance = null;
  (ConfigService as unknown as { _instance: null })._instance = null;
  (JobStorageService as unknown as { _instance: null })._instance = null;
  (LiteSqlService as unknown as { _instance: null })._instance = null;
  (JobExecutorService as unknown as { _instance: null })._instance = null;
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

//#endregion Helpers

describe("LITESQL node execution — object and array inserts", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-litesql-exec-"));
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

  async function setupTableAndJobAsync(): Promise<{ jobId: string; litesqlNodeId: string }> {
    const liteSqlService: LiteSqlService = LiteSqlService.getInstance();
    await liteSqlService.createDatabaseAsync("testdb");
    await liteSqlService.createTableAsync("testdb", "articles", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "url", type: "TEXT", notNull: false },
    ]);

    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("InsertTestJob", "test");

    const startNode = await storage.addNodeAsync(
      job.jobId,
      "start",
      "Start",
      "start",
      {},
      { type: "object", properties: {}, additionalProperties: true },
      { scheduledTaskId: null },
    );
    await storage.updateJobAsync(job.jobId, { entrypointNodeId: startNode.nodeId });

    const litesqlNode = await storage.addNodeAsync(
      job.jobId,
      "litesql",
      "InsertArticles",
      "inserts articles into db",
      {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["title"],
      },
      {
        type: "object",
        properties: {
          insertedCount: { type: "number" },
          lastRowId: { type: "number" },
        },
        required: ["insertedCount", "lastRowId"],
      },
      { databaseName: "testdb", tableName: "articles" },
    );

    // Connect start → litesql
    await storage.updateNodeAsync(job.jobId, startNode.nodeId, {
      connections: [litesqlNode.nodeId],
    });
    await storage.updateJobAsync(job.jobId, { status: "ready" });

    return { jobId: job.jobId, litesqlNodeId: litesqlNode.nodeId };
  }

  it("inserts a single object row", async () => {
    const { jobId } = await setupTableAndJobAsync();
    const executor: JobExecutorService = JobExecutorService.getInstance();

    const result = await executor.executeJobAsync(jobId, {
      title: "Hello World",
      url: "https://example.com",
    });

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ insertedCount: 1, lastRowId: 1 });

    // Verify data actually in DB
    const liteSqlService: LiteSqlService = LiteSqlService.getInstance();
    const queryResult = await liteSqlService.queryTableAsync("testdb", "articles");
    expect(queryResult.rows).toHaveLength(1);
    expect(queryResult.rows[0]).toMatchObject({ title: "Hello World", url: "https://example.com" });
  });

  it("inserts array wrapped in { items: [...] }", async () => {
    // Update the litesql node's inputSchema to accept the wrapper format
    const storage: JobStorageService = JobStorageService.getInstance();
    const { jobId, litesqlNodeId } = await setupTableAndJobAsync();

    // Relax input schema to accept wrapper object
    await storage.updateNodeAsync(jobId, litesqlNodeId, {
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
              },
              required: ["title"],
            },
          },
        },
        required: ["items"],
      },
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();

    const result = await executor.executeJobAsync(jobId, {
      items: [
        { title: "Article 1", url: "https://example.com/1" },
        { title: "Article 2", url: "https://example.com/2" },
        { title: "Article 3", url: "https://example.com/3" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ insertedCount: 3 });

    // Verify all rows in DB
    const liteSqlService: LiteSqlService = LiteSqlService.getInstance();
    const queryResult = await liteSqlService.queryTableAsync("testdb", "articles", { orderBy: "id" });
    expect(queryResult.rows).toHaveLength(3);
    expect(queryResult.rows[0]).toMatchObject({ title: "Article 1" });
    expect(queryResult.rows[2]).toMatchObject({ title: "Article 3" });
  });

  it("rejects insert with missing required columns", async () => {
    const { jobId } = await setupTableAndJobAsync();

    // Relax the node input schema so AJV pass lets the litesql executor validate
    const storage: JobStorageService = JobStorageService.getInstance();
    const nodes = await storage.listNodesAsync(jobId);
    const litesqlNode = nodes.find((n) => n.type === "litesql")!;
    await storage.updateNodeAsync(jobId, litesqlNode.nodeId, {
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();

    // title is NOT NULL but we only send url — should fail
    const result = await executor.executeJobAsync(jobId, {
      url: "https://example.com",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("title");
  });
});
