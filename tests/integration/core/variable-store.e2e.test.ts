import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { VectorStoreService } from "../../../src/services/vector-store.service.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import * as litesql from "../../../src/helpers/litesql.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { MainAgent, type IAgentResult } from "../../../src/agent/main-agent.js";
import type { MessageSender } from "../../../src/tools/index.js";
import type { IToolCallSummary } from "../../../src/agent/base-agent.js";

//#region Constants

const localBaseUrl: string = "http://localhost:2345";
const DB_NAME: string = "blackdog";
const SRC_TABLE: string = "e2e_src";
const DST_TABLE: string = "e2e_dst";
const CHAT_ID: string = "var-e2e-chat";
const ROW_COUNT: number = 25;

//#endregion Constants

//#region State

let tempDir: string;
let originalHome: string;
let endpointReachable: boolean = false;
let shouldSkipLmTests: boolean = false;
let tracePath: string;
let originalLogLlm: string | undefined;
const stepTraces: { stepNumber: number; toolCalls: IToolCallSummary[] }[] = [];
let seedRows: Array<{ id: number; payload: string }> = [];

//#endregion State

//#region Helpers — environment / server gate

const mockMessageSender: MessageSender = async (_message: string): Promise<string | null> => {
  return "mock-message-id";
};

const mockPhotoSender = async (): Promise<string | null> => {
  return null;
};

async function isEndpointReachableAsync(): Promise<boolean> {
  const abortController: AbortController = new AbortController();
  const timeoutId: NodeJS.Timeout = setTimeout(() => abortController.abort(), 3000);
  try {
    const response: Response = await fetch(`${localBaseUrl}/v1/models`, { method: "GET", signal: abortController.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

//#endregion Helpers — environment / server gate

//#region Helpers — seeding

async function seedTablesAsync(): Promise<void> {
  await litesql.ensureDatabaseExists(DB_NAME);
  await litesql.createTableAsync(DB_NAME, SRC_TABLE, [
    { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
    { name: "payload", type: "TEXT", notNull: true },
  ]);
  await litesql.createTableAsync(DB_NAME, DST_TABLE, [
    { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
    { name: "payload", type: "TEXT", notNull: true },
  ]);

  seedRows = [];
  const inserts: Array<{ id: number; payload: string }> = [];
  for (let i: number = 1; i <= ROW_COUNT; i++) {
    const payload: string = `row-${String(i).padStart(3, "0")}-${"a".repeat(180)}`;
    seedRows.push({ id: i, payload });
    inserts.push({ id: i, payload });
  }
  await litesql.insertIntoTableAsync(DB_NAME, SRC_TABLE, inserts);
}

/** Read all rows from a table, tolerating a missing table/database. */
async function readTableForceAsync(tableName: string): Promise<Array<{ id: number; payload: string }>> {
  try {
    const result = await litesql.queryTableAsync(DB_NAME, tableName, { orderBy: "id ASC" });
    return result.rows as Array<{ id: number; payload: string }>;
  } catch {
    return [];
  }
}

//#endregion Helpers — seeding

//#region Helpers — trace / step analysis

interface ITraceRecord {
  requestBody: unknown;
}

/** Walk a single request body's messages for assistant tool-call entries. */
function _toolCallsFromRequest(requestBody: unknown): Array<{ name: string; args: unknown }> {
  const out: Array<{ name: string; args: unknown }> = [];
  if (!requestBody || typeof requestBody !== "object") {
    return out;
  }
  const messages: unknown[] = (requestBody as Record<string, unknown>).messages as unknown[];
  if (!Array.isArray(messages)) {
    return out;
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as { role?: string }).role !== "assistant") {
      continue;
    }
    const content: unknown = (msg as { content?: unknown }).content;
    const items: unknown[] = Array.isArray(content)
      ? content
      : content != null
        ? [content]
        : [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const t = item as { type?: string; toolName?: string; args?: unknown };
      if (t.type !== "tool-call") {
        continue;
      }
      let args: unknown = t.args;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          continue;
        }
      }
      out.push({ name: t.toolName as string, args });
    }
  }
  return out;
}

interface ITraceReport {
  records: number;
  hadVariableRef: boolean;
  varCallArgBytes: number;
  literalWriteBytes: number;
}

async function analyzeTraceAsync(): Promise<ITraceReport> {
  const report: ITraceReport = { records: 0, hadVariableRef: false, varCallArgBytes: 0, literalWriteBytes: 0 };
  let content: string;
  try {
    content = await fs.readFile(tracePath, "utf-8");
  } catch {
    return report; // no trace file written (e.g. tracing disabled / streaming)
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let rec: ITraceRecord;
    try {
      rec = JSON.parse(line) as ITraceRecord;
    } catch {
      continue;
    }
    report.records++;
    for (const { name, args } of _toolCallsFromRequest(rec.requestBody)) {
      if (name !== `write_table_${DST_TABLE}` || !args || typeof args !== "object") {
        continue;
      }
      const data: unknown = (args as Record<string, unknown>).data;
      if (data && typeof data === "object" && (data as { type?: string }).type === "variable") {
        report.hadVariableRef = true;
        report.varCallArgBytes = Math.max(report.varCallArgBytes, Buffer.byteLength(JSON.stringify(data), "utf8"));
      } else if (Array.isArray(data)) {
        report.literalWriteBytes = Math.max(report.literalWriteBytes, Buffer.byteLength(JSON.stringify(data), "utf8"));
      }
    }
  }
  return report;
}

interface IStepReport {
  hadVariableRef: boolean;
  varCallArgBytes: number;
  literalWriteBytes: number;
  errorCalls: number;
}

/**
 * Step traces capture the RAW model-emitted args (pre-resolution), so they are the
 * most reliable indicator of whether the model emitted a variable reference.
 */
function analyzeStepsAsync(): IStepReport {
  const report: IStepReport = { hadVariableRef: false, varCallArgBytes: 0, literalWriteBytes: 0, errorCalls: 0 };
  for (const st of stepTraces) {
    for (const tc of st.toolCalls) {
      if (tc.isError) {
        report.errorCalls++;
      }
      if (tc.name !== `write_table_${DST_TABLE}`) {
        continue;
      }
      const data: unknown = (tc.input as Record<string, unknown>).data;
      if (data && typeof data === "object" && (data as { type?: string }).type === "variable") {
        report.hadVariableRef = true;
        report.varCallArgBytes = Math.max(report.varCallArgBytes, Buffer.byteLength(JSON.stringify(data), "utf8"));
      } else if (Array.isArray(data)) {
        report.literalWriteBytes = Math.max(report.literalWriteBytes, Buffer.byteLength(JSON.stringify(data), "utf8"));
      }
    }
  }
  return report;
}

//#endregion Helpers — trace / step analysis

//#region Tests

describe("VariableStore E2E — blackboard relay (Ornith)", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-varstore-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Opt-in LLM trace to a scratch path so we can report variable-ref usage.
    tracePath = path.join(tempDir, "llm-trace.jsonl");
    originalLogLlm = process.env.BLACKDOG_LOG_LLM;
    process.env.BLACKDOG_LOG_LLM = tracePath;
    // Let reads return all seeded rows (default cap is 20).
    process.env.BLACKDOGBOT_READ_DB_DEFAULT_LIMIT = "50";

    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");
    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);

    // Server-availability gate — skip cleanly if the local model server is down.
    endpointReachable = await isEndpointReachableAsync();
    const provider: string = aiProviderService.getActiveProvider();
    shouldSkipLmTests = !endpointReachable || provider === "lm-studio";

    if (!shouldSkipLmTests) {
      const promptService: PromptService = PromptService.getInstance();
      await promptService.initializeAsync();

      // NOTE: embedding + vector-store init are intentionally skipped. The copy task
      // only exercises the table tools (read_from_database / write_table_*); the
      // knowledge/vector tools resolve the vector store lazily at use-time only, so
      // they are never touched here. Skipping the HF embedding download keeps the
      // setup fast and deterministic.
      const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();
      await skillLoaderService.loadAllSkillsAsync([]);

      const channelRegistry: ChannelRegistryService = ChannelRegistryService.getInstance();
      await channelRegistry.initializeAsync();
      await channelRegistry.registerChannelAsync("telegram", CHAT_ID, {
        permission: "full",
        receiveNotifications: false,
      });

      // Seed BOTH tables BEFORE the agent build so per-table write tools (including
      // write_table_e2e_dst) and the read table list are discovered at build time.
      await seedTablesAsync();

      const mainAgent: MainAgent = MainAgent.getInstance();
      await mainAgent.initializeForChatAsync(
        CHAT_ID,
        mockMessageSender,
        mockPhotoSender,
        async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
          stepTraces.push({ stepNumber, toolCalls });
          for (const tc of toolCalls) {
            if (tc.name === "write_table_" + DST_TABLE) {
              const data: unknown = (tc.input as Record<string, unknown>).data;
              const kind =
                data && typeof data === "object" && (data as { type?: string }).type === "variable"
                  ? "variable-ref"
                  : Array.isArray(data)
                    ? "literal-array"
                    : "other";
              console.log(
                `[var-store-e2e] STEP ${stepNumber} write_table_${DST_TABLE} args=${kind} isError=${!!tc.isError}` +
                  (tc.result !== undefined ? ` result=${JSON.stringify(tc.result).slice(0, 120)}` : ""),
              );
            }
          }
        },
        "telegram",
      );
    }
  }, 600000);

  afterAll(async () => {
    // The vector store is intentionally not initialized in this test (see beforeAll),
    // so guard its close in case it was never set up.
    try {
      const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
      await vectorStoreService.closeAsync();
    } catch {
      // not initialized — nothing to close
    }

    process.env.HOME = originalHome;
    if (originalLogLlm === undefined) {
      delete process.env.BLACKDOG_LOG_LLM;
    } else {
      process.env.BLACKDOG_LOG_LLM = originalLogLlm;
    }
    delete process.env.BLACKDOGBOT_READ_DB_DEFAULT_LIMIT;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("copies e2e_src -> e2e_dst through the variable blackboard", async () => {
    if (shouldSkipLmTests) {
      console.log(
        `[var-store-e2e] SKIPPED (endpointReachable=${endpointReachable}, provider="${
          AiProviderService.getInstance().getActiveProvider()
        }"). No live model to drive the relay.`,
      );
      return;
    }

    const mainAgent: MainAgent = MainAgent.getInstance();
    // Explicit so the local model uses the table tools (not run_cmd) and exercises the
    // variable reference from the read stub — the plumbing we are verifying.
    const prompt: string =
      "Read all 25 rows from the " + SRC_TABLE + " table using the read_from_database tool (\"tableName\": \"" + SRC_TABLE + "\"). " +
      "The read result appears as a stub that contains a variable name. Use the write_table_" + DST_TABLE +
      " tool with its \"data\" argument set to a variable reference of the form " +
      "{\"type\":\"variable\",\"name\":<the variable name from the stub>} to insert all the rows into " + DST_TABLE +
      ". Do not use run_cmd and do not re-type the data yourself.";

    // The model is in the loop; retry once on a transient failure (e.g. the known
    // llama-server headers-timeout flake) so the test asserts plumbing, not one-shot.
    let result: IAgentResult;
    try {
      result = await mainAgent.processMessageForChatAsync(CHAT_ID, prompt);
    } catch {
      result = await mainAgent.processMessageForChatAsync(CHAT_ID, prompt);
    }

    // ---- ASSERT plumbing / side effects only (HANDOFF §8) ----
    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");

    const stepReport: IStepReport = analyzeStepsAsync();
    const toolNames: string[] = stepTraces.flatMap((st) => st.toolCalls.map((tc) => tc.name));
    // The model must encounter the large read result (read tool is invoked) and attempt
    // the write into the destination table — the plumbing the blackboard plugs into.
    expect(toolNames).toContain("read_from_database");
    expect(toolNames).toContain("write_table_" + DST_TABLE);

    // Diagnostic: did the relay actually land rows, and did any write error out?
    let dstRows: Array<{ id: number; payload: string }> = [];
    try {
      dstRows = await readTableForceAsync(DST_TABLE);
    } catch {
      dstRows = [];
    }

    // D5.1: with FIX-1 the relay works — the write must land every seeded row intact.
    const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;
    expect(dstRows).toHaveLength(ROW_COUNT);
    expect([...dstRows].sort(byId)).toEqual([...seedRows].sort(byId));

    // ---- REPORT (not asserted) — can Ornith actually use the blackboard? ----
    const traceReport: ITraceReport = await analyzeTraceAsync();
    const literal25RowsBytes: number = Buffer.byteLength(JSON.stringify(seedRows), "utf8");

    console.log("[var-store-e2e] ===================== REPORT =====================");
    console.log(`[var-store-e2e] endpointReachable=${endpointReachable}  traceRecords=${traceReport.records}`);
    console.log(
      `[var-store-e2e] step-traces: write_table_${DST_TABLE} used a {"type":"variable"} ref = ${stepReport.hadVariableRef}` +
        (stepReport.hadVariableRef ? `  (args=${stepReport.varCallArgBytes} bytes)` : ""),
    );
    console.log(
      `[var-store-e2e] trace-jsonl: write_table_${DST_TABLE} used a {"type":"variable"} ref = ${traceReport.hadVariableRef}` +
        (traceReport.hadVariableRef ? `  (args=${traceReport.varCallArgBytes} bytes)` : ""),
    );
    const writeCalls = stepTraces
      .flatMap((st) => st.toolCalls)
      .filter((tc) => tc.name === "write_table_" + DST_TABLE);
    const writeSummary = writeCalls
      .map((tc) => {
        const data: unknown = (tc.input as Record<string, unknown>).data;
        const kind =
          data && typeof data === "object" && (data as { type?: string }).type === "variable"
            ? "variable-ref"
            : Array.isArray(data)
              ? "literal-array"
              : "other";
        return `${kind}${tc.isError ? " (ERROR)" : ""}`;
      })
      .join(", ") || "(none)";

    console.log("[var-store-e2e] write_table_" + DST_TABLE + " calls: " + writeSummary);
    console.log("[var-store-e2e] dst " + DST_TABLE + " row count after run: " + dstRows.length + " (seeded " + ROW_COUNT + ")");
    console.log("[var-store-e2e] tool calls in run: " + (toolNames.join(" → ") || "(none)"));

    if (stepReport.hadVariableRef || traceReport.hadVariableRef) {
      const argBytes: number = Math.max(stepReport.varCallArgBytes, traceReport.varCallArgBytes);
      console.log(
        `[var-store-e2e] relay byte-length via variable ref ≈ ${argBytes} bytes  vs.  literal ${ROW_COUNT}-row JSON ≈ ${literal25RowsBytes} bytes` +
          `  (saved ≈ ${literal25RowsBytes - argBytes} bytes, ~${Math.round((literal25RowsBytes - argBytes) / 4)} tokens)`,
      );
    } else {
      console.log(
        `[var-store-e2e] model wrote a literal array (≈${traceReport.literalWriteBytes} bytes) instead of a variable ref`,
      );
    }
    console.log("[var-store-e2e] ===================== END REPORT =====================");
  }, 1800000);
});

//#endregion Tests
