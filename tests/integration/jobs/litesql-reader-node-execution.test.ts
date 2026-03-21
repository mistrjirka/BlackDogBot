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


describe("LITESQL_READER node execution", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-litesql-reader-"));
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

  async function seedDatabaseAsync(): Promise<void> {
    await litesql.createDatabaseAsync("testdb");
    await litesql.createTableAsync("testdb", "articles", [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "category", type: "TEXT", notNull: false },
      { name: "score", type: "INTEGER", notNull: false },
    ]);

    await litesql.insertIntoTableAsync("testdb", "articles", { title: "Alpha", category: "tech", score: 10 });
    await litesql.insertIntoTableAsync("testdb", "articles", { title: "Beta", category: "science", score: 20 });
    await litesql.insertIntoTableAsync("testdb", "articles", { title: "Gamma", category: "tech", score: 30 });
  }

  async function buildReaderJobAsync(config: any): Promise<string> {
    const storage: JobStorageService = JobStorageService.getInstance();
    const job = await storage.createJobAsync("ReaderJob", "test");

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

    const readerNode = await storage.addNodeAsync(
      job.jobId,
      "litesql_reader",
      "ReadArticles",
      "reads articles from db",
      { type: "object", properties: {}, additionalProperties: true },
      {
        type: "object",
        properties: {
          rows: { type: "array" },
          totalCount: { type: "integer" },
        },
      },
      config,
    );

    await storage.updateNodeAsync(job.jobId, startNode.nodeId, {
      connections: [readerNode.nodeId],
    });
    await storage.updateJobAsync(job.jobId, { status: "ready" });

    return job.jobId;
  }

  it("fetches all rows from a table", async () => {
    await seedDatabaseAsync();
    const jobId = await buildReaderJobAsync({
      databaseName: "testdb",
      tableName: "articles",
      where: null,
      orderBy: null,
      limit: null,
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const result = await executor.executeJobAsync(jobId, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.output).toMatchObject({ totalCount: 3 });
    expect((result.output as { rows: unknown[] }).rows).toHaveLength(3);
  });

  it("applies WHERE clause filtering", async () => {
    await seedDatabaseAsync();
    const jobId = await buildReaderJobAsync({
      databaseName: "testdb",
      tableName: "articles",
      where: "category = 'tech'",
      orderBy: "score ASC",
      limit: null,
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const result = await executor.executeJobAsync(jobId, {});

    expect(result.success).toBe(true);
    const output = result.output as { rows: Record<string, unknown>[]; totalCount: number };
    expect(output.totalCount).toBe(2);
    expect(output.rows).toHaveLength(2);
    expect(output.rows[0]).toMatchObject({ title: "Alpha", score: 10 });
    expect(output.rows[1]).toMatchObject({ title: "Gamma", score: 30 });
  });

  it("applies LIMIT", async () => {
    await seedDatabaseAsync();
    const jobId = await buildReaderJobAsync({
      databaseName: "testdb",
      tableName: "articles",
      where: null,
      orderBy: "score DESC",
      limit: 2,
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const result = await executor.executeJobAsync(jobId, {});

    expect(result.success).toBe(true);
    const output = result.output as { rows: Record<string, unknown>[]; totalCount: number };
    expect(output.totalCount).toBe(3);
    expect(output.rows).toHaveLength(2);
    expect(output.rows[0]).toMatchObject({ title: "Gamma", score: 30 });
  });

  it("supports template substitution in WHERE clause", async () => {
    await seedDatabaseAsync();
    const jobId = await buildReaderJobAsync({
      databaseName: "testdb",
      tableName: "articles",
      where: "category = '{{cat}}'",
      orderBy: null,
      limit: null,
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const result = await executor.executeJobAsync(jobId, { cat: "science" });

    expect(result.success).toBe(true);
    const output = result.output as { rows: Record<string, unknown>[]; totalCount: number };
    expect(output.totalCount).toBe(1);
    expect(output.rows[0]).toMatchObject({ title: "Beta", category: "science" });
  });

  it("errors when database does not exist", async () => {
    const jobId = await buildReaderJobAsync({
      databaseName: "nonexistent",
      tableName: "articles",
      where: null,
      orderBy: null,
      limit: null,
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const result = await executor.executeJobAsync(jobId, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("nonexistent");
    expect(result.error).toContain("does not exist");
  });

  it("errors when table does not exist", async () => {
    await litesql.createDatabaseAsync("testdb");

    const jobId = await buildReaderJobAsync({
      databaseName: "testdb",
      tableName: "nonexistent",
      where: null,
      orderBy: null,
      limit: null,
    });

    const executor: JobExecutorService = JobExecutorService.getInstance();
    const result = await executor.executeJobAsync(jobId, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("nonexistent");
    expect(result.error).toContain("does not exist");
  });
});
