import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { JobStorageService } from "../../../src/services/job-storage.service.js";
import * as litesql from "../../../src/helpers/litesql.js";
import { JobExecutorService } from "../../../src/services/job-executor.service.js";


let tempDir: string;
let originalHome: string;


async function initServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  const sharedLogDir: string = path.join(os.tmpdir(), "betterclaw-test-logs");
  await fs.mkdir(sharedLogDir, { recursive: true });
  await loggerService.initializeAsync("error", sharedLogDir);

  const configService: ConfigService = ConfigService.getInstance();
  const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
  const tempConfigDir: string = path.join(tempDir, ".betterclaw");
  await fs.mkdir(tempConfigDir, { recursive: true });
  await fs.cp(realConfigPath, path.join(tempConfigDir, "config.yaml"));
  await configService.initializeAsync(path.join(tempConfigDir, "config.yaml"));
}


describe("LITESQL node execution — object and array inserts", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-litesql-exec-"));
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

  async function setupTableAndJobAsync(): Promise<{ jobId: string; litesqlNodeId: string }> {
    await litesql.createDatabaseAsync("testdb");
    await litesql.createTableAsync("testdb", "articles", [
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

    const queryResult = await litesql.queryTableAsync("testdb", "articles");
    expect(queryResult.rows).toHaveLength(1);
    expect(queryResult.rows[0]).toMatchObject({ title: "Hello World", url: "https://example.com" });
  });

  it("inserts array wrapped in { items: [...] }", async () => {
    const storage: JobStorageService = JobStorageService.getInstance();
    const { jobId, litesqlNodeId } = await setupTableAndJobAsync();

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

    const queryResult = await litesql.queryTableAsync("testdb", "articles", { orderBy: "id" });
    expect(queryResult.rows).toHaveLength(3);
    expect(queryResult.rows[0]).toMatchObject({ title: "Article 1" });
    expect(queryResult.rows[2]).toMatchObject({ title: "Article 3" });
  });

  it("rejects insert with missing required columns", async () => {
    const { jobId } = await setupTableAndJobAsync();

    const storage: JobStorageService = JobStorageService.getInstance();
    const nodes = await storage.listNodesAsync(jobId);
    const litesqlNode = nodes.find((n) => n.type === "litesql")!;
    await storage.updateNodeAsync(jobId, litesqlNode.nodeId, {
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();

    const result = await executor.executeJobAsync(jobId, {
      url: "https://example.com",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("title");
  });
});
