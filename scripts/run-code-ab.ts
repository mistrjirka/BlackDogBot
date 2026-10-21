/**
 * Phase 2 A/B harness runner (plan §3). Run via `npx tsx scripts/run-code-ab.ts`.
 *
 * Usage:
 *   npx tsx scripts/run-code-ab.ts --smoke --task 1          # gate §6: 1 arm-A + 1 arm-B run
 *   npx tsx scripts/run-code-ab.ts --arm a --task all --n 5  # arm-A campaign (20 runs)
 *   npx tsx scripts/run-code-ab.ts --arm b --task all --n 5  # arm-B campaign (20 runs)
 *   npx tsx scripts/run-code-ab.ts --report                  # AB-REPORT.md + ab-summary.json
 *
 * Per-run boot is copied 1:1 from the e2e beforeAll
 * (tests/integration/core/variable-store.e2e.test.ts:231-313), with the
 * deliberate exception that BLACKDOGBOT_READ_DB_DEFAULT_LIMIT is NOT set
 * (default limit 20 stands, plan §3.2 step 3).
 *
 * Arm-A compatibility (§3.5): imports only APIs that exist at 3aee99df.
 * In particular variable-store.js is NEVER imported (arm A has no store).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../src/services/config.service.js";
import { LoggerService } from "../src/services/logger.service.js";
import { AiProviderService } from "../src/services/ai-provider.service.js";
import { PromptService } from "../src/services/prompt.service.js";
import { SkillLoaderService } from "../src/services/skill-loader.service.js";
import { ChannelRegistryService } from "../src/services/channel-registry.service.js";
import { EmbeddingService } from "../src/services/embedding.service.js";
import { VectorStoreService } from "../src/services/vector-store.service.js";
import { SchedulerService } from "../src/services/scheduler.service.js";
import { MessagingService } from "../src/services/messaging.service.js";
import { RateLimiterService } from "../src/services/rate-limiter.service.js";
import { McpRegistryService } from "../src/services/mcp-registry.service.js";
import { McpService } from "../src/services/mcp.service.js";
import * as litesql from "../src/helpers/litesql.js";
import { MainAgent, type IAgentResult } from "../src/agent/main-agent.js";
import type { MessageSender } from "../src/tools/index.js";
import type { IToolCallSummary } from "../src/agent/base-agent.js";

import { DB_NAME, seedTaskAsync } from "../tests/fixtures/run-code-ab/seed.js";
import { getTaskDef } from "../tests/fixtures/run-code-ab/tasks.js";
import {
  destructiveDiff,
  firstDivergence,
  isSyntaxErrorText,
  parseTraceLine,
  relayReport,
  resolverReport,
  rowsEqual,
  tokenTotals,
  type DbDump,
  type ITraceRecordLike,
} from "../tests/fixtures/run-code-ab/metrics.js";
import { writeReportAsync, type IReportHeader } from "../tests/fixtures/run-code-ab/report.js";

//#region Constants

const LOCAL_BASE_URL: string = "http://localhost:2345";
const RUN_TIMEOUT_MS: number = 900_000; // 15 min (plan §3.3)
const RESEARCH_DIR: string = path.join(".pi-subagents", "research-2026-09");
const DEFAULT_OUT_DIR: string = path.join(RESEARCH_DIR, "ab-artifacts");
const ARM_A_REF: string = "3aee99df";
const ARM_A_WORKTREE: string = path.join(".worktrees", "ptc-ab-arm-a");

const SINGLETON_CLASSES: { _instance: unknown }[] = [
  ConfigService as unknown as { _instance: unknown },
  LoggerService as unknown as { _instance: unknown },
  EmbeddingService as unknown as { _instance: unknown },
  VectorStoreService as unknown as { _instance: unknown },
  AiProviderService as unknown as { _instance: unknown },
  SchedulerService as unknown as { _instance: unknown },
  ChannelRegistryService as unknown as { _instance: unknown },
  MessagingService as unknown as { _instance: unknown },
  SkillLoaderService as unknown as { _instance: unknown },
  RateLimiterService as unknown as { _instance: unknown },
  PromptService as unknown as { _instance: unknown },
  MainAgent as unknown as { _instance: unknown },
  McpRegistryService as unknown as { _instance: unknown },
  McpService as unknown as { _instance: unknown },
];

/** Inline 14-class reset — mirrors tests/utils/test-helpers.ts:38-59 (that module
 *  cannot be imported: module-level `import { vi } from "vitest"` throws outside vitest). */
function resetSingletons(): void {
  for (const Service of SINGLETON_CLASSES) {
    Service._instance = null;
  }
}

const mockMessageSender: MessageSender = async (_message: string): Promise<string | null> => {
  return "mock-message-id";
};

const mockPhotoSender = async (): Promise<string | null> => {
  return null;
};

//#endregion Constants

//#region CLI

interface ICli {
  arm: "a" | "b" | null;
  tasks: number[];
  n: number;
  smoke: boolean;
  report: boolean;
  out: string;
}

function parseCli(argv: string[]): ICli {
  const cli: ICli = { arm: null, tasks: [], n: 5, smoke: false, report: false, out: DEFAULT_OUT_DIR };
  for (let i: number = 0; i < argv.length; i++) {
    const a: string = argv[i];
    if (a === "--arm") {
      const v: string = argv[++i];
      if (v !== "a" && v !== "b") {
        throw new Error(`--arm must be a|b, got ${v}`);
      }
      cli.arm = v;
    } else if (a === "--task") {
      const v: string = argv[++i];
      cli.tasks = v === "all" ? [1, 2, 3, 4] : [Number(v)];
      if (cli.tasks.some((t) => ![1, 2, 3, 4].includes(t))) {
        throw new Error(`--task must be 1|2|3|4|all, got ${v}`);
      }
    } else if (a === "--n") {
      cli.n = Number(argv[++i]);
    } else if (a === "--smoke") {
      cli.smoke = true;
    } else if (a === "--report") {
      cli.report = true;
    } else if (a === "--out") {
      cli.out = argv[++i];
    } else {
      throw new Error(`unknown flag ${a}`);
    }
  }
  if (!cli.report && cli.tasks.length === 0) {
    throw new Error("missing required --task 1|2|3|4|all");
  }
  if (cli.smoke) {
    cli.n = 1;
  }
  return cli;
}

//#endregion CLI

//#region DB dump (plan §4.7)

async function dumpDbAsync(): Promise<DbDump> {
  const dump: DbDump = {};
  let tables: string[] = [];
  try {
    tables = await litesql.listTablesAsync(DB_NAME);
  } catch {
    return dump;
  }
  for (const t of tables.sort()) {
    try {
      const res = await litesql.queryTableAsync(DB_NAME, t, { orderBy: "id ASC" });
      dump[t] = res.rows;
    } catch {
      dump[t] = [];
    }
  }
  return dump;
}

//#endregion DB dump

//#region Per-run boot + execution (plan §3.2–§3.4)

interface IStepEntry {
  step: number;
  tools: { name: string; isError: boolean; argBytes: number; resultSnippet: string }[];
}

interface IRunOutcome {
  resultJson: Record<string, unknown>;
  bootMs: number;
}

async function serverReachableAsync(): Promise<boolean> {
  const ctl: AbortController = new AbortController();
  const timer: NodeJS.Timeout = setTimeout(() => ctl.abort(), 3000);
  try {
    const res: Response = await fetch(`${LOCAL_BASE_URL}/v1/models`, { method: "GET", signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delayAsync(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

async function readTraceRecordsAsync(tracePath: string): Promise<ITraceRecordLike[]> {
  let content: string;
  try {
    content = await fs.readFile(tracePath, "utf-8");
  } catch {
    return [];
  }
  const out: ITraceRecordLike[] = [];
  for (const line of content.split("\n")) {
    const rec: ITraceRecordLike | null = parseTraceLine(line);
    if (rec) {
      out.push(rec);
    }
  }
  return out;
}

/** One attempt: full boot (§3.2) + execution (§3.3) + post-run (§3.4). Throws on transport error. */
async function attemptOnceAsync(
  arm: "a" | "b",
  task: number,
  runIndex: number,
  outDir: string,
): Promise<IRunOutcome> {
  const def = getTaskDef(task);
  const runDir: string = path.join(outDir, arm, `task-${task}`, `run-${runIndex}`);
  await fs.mkdir(runDir, { recursive: true });
  const tracePath: string = path.join(runDir, "trace.jsonl");

  const originalHome: string = process.env.HOME ?? os.homedir();
  const tempDir: string = await fs.mkdtemp(path.join(os.tmpdir(), `ptc-ab-${arm}-t${task}-r${runIndex}-`));
  process.env.HOME = tempDir;
  const bootStart: number = Date.now();
  const stepTrace: IStepEntry[] = [];
  let timedOut: boolean = false;
  let agentText: string = "";
  let stepsCount: number = 0;

  try {
    resetSingletons();

    process.env.BLACKDOG_LOG_LLM = tracePath;
    // Deliberately NOT set: BLACKDOGBOT_READ_DB_DEFAULT_LIMIT (keep default 20).
    delete process.env.BLACKDOGBOT_READ_DB_DEFAULT_LIMIT;

    const realConfigPath: string = path.join(originalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");
    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    await LoggerService.getInstance().initializeAsync("info", path.join(tempDir, "logs"));
    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);
    AiProviderService.getInstance().initialize(configService.getConfig().ai);

    if (!(await serverReachableAsync())) {
      throw new Error("CAMPAIGN-ABORTED: model server unreachable at localhost:2345/v1/models");
    }

    await PromptService.getInstance().initializeAsync();
    // Embedding + vector-store init intentionally skipped (lazy tools, e2e :269-272).
    await SkillLoaderService.getInstance().loadAllSkillsAsync([]);
    const channelRegistry: ChannelRegistryService = ChannelRegistryService.getInstance();
    await channelRegistry.initializeAsync();
    const chatId: string = `ptc-ab-${arm}-t${task}-r${runIndex}`;
    await channelRegistry.registerChannelAsync("telegram", chatId, {
      permission: "full",
      receiveNotifications: false,
    });

    // Seed BEFORE the agent build (per-table write tools discovered at build time).
    await seedTaskAsync(task);
    const dbBefore: DbDump = await dumpDbAsync();

    const mainAgent: MainAgent = MainAgent.getInstance();
    await mainAgent.initializeForChatAsync(
      chatId,
      mockMessageSender,
      mockPhotoSender,
      async (stepNumber: number, toolCalls: IToolCallSummary[]): Promise<void> => {
        stepTrace.push({
          step: stepNumber,
          tools: toolCalls.map((tc) => ({
            name: tc.name,
            isError: !!tc.isError,
            argBytes: Buffer.byteLength(JSON.stringify(tc.input ?? null), "utf8"),
            resultSnippet: tc.result === undefined ? "" : JSON.stringify(tc.result).slice(0, 300),
          })),
        });
      },
      "telegram",
    );
    const bootMs: number = Date.now() - bootStart;
    const runStart: number = Date.now();

    // Execution with timeout + abort (§3.3). A transport REJECTION propagates
    // (→ retry handler); only the timeout resolves to null here.
    const pending: Promise<IAgentResult> = mainAgent.processMessageForChatAsync(chatId, def.prompt);
    const raced: { v: IAgentResult } | null = await Promise.race([
      pending.then((v) => ({ v }) as { v: IAgentResult }),
      delayAsync(RUN_TIMEOUT_MS),
    ]);
    let result: IAgentResult;
    if (raced === null) {
      mainAgent.stopChat(chatId);
      result = await pending;
      timedOut = true;
    } else {
      result = raced.v;
    }
    agentText = result.text ?? "";
    stepsCount = result.stepsCount ?? stepTrace.length;
    const durationMs: number = Date.now() - runStart;

    const dbAfter: DbDump = await dumpDbAsync();
    const expected: Record<string, unknown>[] = await def.expectedTargetRowsAsync();
    const actual: Record<string, unknown>[] = dbAfter[def.targetTable] ?? [];
    const stateOk: boolean = rowsEqual(actual, expected);
    const diff = destructiveDiff(dbBefore, dbAfter, def.allowedWriteTables);
    const records: ITraceRecordLike[] = await readTraceRecordsAsync(tracePath);
    const tokens = tokenTotals(records);
    const relay = relayReport(records);
    const resolver = arm === "a"
      ? { rule1: 0, rule2: 0, literal: 0, unknown: [] as unknown[] }
      : resolverReport(records);

    let status: string;
    let success: boolean;
    if (timedOut) {
      status = "timeout";
      success = false;
    } else if (/duplicate tool calls/i.test(agentText)) {
      status = "error_other";
      success = false;
    } else if (stateOk && !diff.destructive) {
      status = "success";
      success = true;
    } else {
      status = "logic";
      success = false;
    }

    const syntaxErrors: number = stepTrace.reduce(
      (n, s) => n + s.tools.filter((t) => t.isError && isSyntaxErrorText(`${t.name} ${t.resultSnippet}`)).length,
      0,
    );
    const failures = {
      unknown_variable: resolver.unknown.length,
      syntax: syntaxErrors,
      logic: status === "logic" ? 1 : 0,
      timeout: status === "timeout" ? 1 : 0,
      error_other: status === "error_other" ? 1 : 0,
    };

    await fs.writeFile(path.join(runDir, "db-before.json"), JSON.stringify(dbBefore, null, 2), "utf-8");
    await fs.writeFile(path.join(runDir, "db-after.json"), JSON.stringify(dbAfter, null, 2), "utf-8");
    if (!success && (status === "logic" || status === "error_other")) {
      const divergence: string = status === "logic"
        ? firstDivergence(actual, expected)
        : agentText.slice(0, 2000);
      await fs.writeFile(path.join(runDir, "failure.txt"), divergence, "utf-8");
    }

    const resultJson: Record<string, unknown> = {
      arm, task, run: runIndex, status, success,
      destructive: diff.destructive,
      destructiveDetail: diff,
      tokens, relay, resolver, failures,
      steps: stepsCount,
      durationMs,
      bootMs,
      timedOut,
      retried: false,
      finalText2000: agentText.slice(0, 2000),
      stepTrace,
    };
    await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify(resultJson, null, 2), "utf-8");
    return { resultJson, bootMs };
  } finally {
    resetSingletons();
    if (process.env.HOME === tempDir) {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Run slot with the single allowed transport retry (§5.2: fresh re-boot; timeouts NOT retried). */
async function runSlotAsync(arm: "a" | "b", task: number, runIndex: number, outDir: string): Promise<Record<string, unknown>> {
  const runDir: string = path.join(outDir, arm, `task-${task}`, `run-${runIndex}`);
  try {
    const { resultJson } = await attemptOnceAsync(arm, task, runIndex, outDir);
    return resultJson;
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    if (message.startsWith("CAMPAIGN-ABORTED")) {
      throw error;
    }
    // Transport throw → one full re-boot retry on a fresh trace (rename attempt 1).
    console.log(`[run-code-ab] ${arm}/task-${task}/run-${runIndex} transport throw, retrying once: ${message.slice(0, 200)}`);
    try {
      await fs.rename(path.join(runDir, "trace.jsonl"), path.join(runDir, "trace-attempt1.jsonl"));
    } catch {
      // no trace yet — nothing to preserve
    }
    try {
      const { resultJson } = await attemptOnceAsync(arm, task, runIndex, outDir);
      resultJson.retried = true;
      await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify(resultJson, null, 2), "utf-8");
      return resultJson;
    } catch (error2: unknown) {
      const message2: string = error2 instanceof Error ? error2.message : String(error2);
      if (message2.startsWith("CAMPAIGN-ABORTED")) {
        throw error2;
      }
      const resultJson: Record<string, unknown> = {
        arm, task, run: runIndex, status: "error_other", success: false,
        destructive: false,
        destructiveDetail: { destructive: false, addedTables: [], droppedTables: [], changedTables: [] },
        tokens: { in: 0, out: 0, total: 0, probeTotal: 0, records: 0, missingUsage: 0 },
        relay: { totalChars: 0, meanChars: 0, p90Chars: 0, top3: [] },
        resolver: { rule1: 0, rule2: 0, literal: 0, unknown: [] },
        failures: { unknown_variable: 0, syntax: 0, logic: 0, timeout: 0, error_other: 1 },
        steps: 0, durationMs: 0, bootMs: 0, timedOut: false, retried: true,
        finalText2000: `transport double-failure: ${message2} / ${message}`.slice(0, 2000),
        stepTrace: [],
      };
      await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify(resultJson, null, 2), "utf-8");
      return resultJson;
    }
  }
}

//#endregion Per-run boot + execution

//#region Campaign sequencing (§5.1 task-interleaved)

async function runArmInProcessAsync(arm: "a" | "b", tasks: number[], n: number, outDir: string): Promise<void> {
  for (const task of tasks) {
    for (let i: number = 1; i <= n; i++) {
      console.log(`[run-code-ab] START arm=${arm} task=${task} run=${i}/${n}`);
      const r = await runSlotAsync(arm, task, i, outDir);
      console.log(
        `[run-code-ab] DONE arm=${arm} task=${task} run=${i} status=${r.status} success=${r.success} ` +
        `tokens=${(r.tokens as { total: number }).total} relay=${Math.round((r.relay as { totalChars: number }).totalChars)}`,
      );
    }
  }
}

/** Spawn the identical runner file inside the arm-A worktree (plan §3.1). */
function runArmAChild(task: number, n: number, outDir: string): void {
  const absOut: string = path.resolve(outDir);
  console.log(`[run-code-ab] spawning arm-A child: task=${task} n=${n}`);
  const res = spawnSync(
    "npx",
    ["tsx", "scripts/run-code-ab.ts", "--arm", "a", "--task", String(task), "--n", String(n), "--out", absOut],
    { cwd: path.resolve(ARM_A_WORKTREE), stdio: "inherit", env: process.env },
  );
  if (res.status !== 0) {
    throw new Error(`arm-A child failed for task ${task} (exit ${res.status})`);
  }
}

async function writeCampaignMeta(outDir: string, n: number): Promise<void> {
  const head: string = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
  const diffSha: string = createHash("sha256")
    .update(spawnSync("git", ["diff", "HEAD", "--", "src", "tests"], { encoding: "utf-8" }).stdout)
    .digest("hex");
  let patchSha: string = "";
  try {
    patchSha = createHash("sha256")
      .update(spawnSync("cat", ["tests/fixtures/run-code-ab/patches/usage-trace.patch"], { encoding: "utf-8" }).stdout)
      .digest("hex");
  } catch {
    patchSha = "unavailable";
  }
  const meta: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    armARef: ARM_A_REF,
    armBHead: head,
    armBDiffSha256: diffSha,
    usagePatchSha256: patchSha,
    runsPerTask: n,
    timeoutSec: RUN_TIMEOUT_MS / 1000,
  };
  spawnSync("mkdir", ["-p", outDir]);
  await fs.writeFile(path.join(outDir, "campaign-meta.json"), JSON.stringify(meta, null, 2));
}

//#endregion Campaign sequencing

//#region Report header (plan §4.9)

async function buildHeaderAsync(outDir: string, n: number): Promise<IReportHeader> {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await fs.readFile(path.join(outDir, "campaign-meta.json"), "utf-8"));
  } catch {
    // no meta (e.g. report on a hand-rolled artifact tree) — fall back to live values
  }
  let model: string = "unknown";
  try {
    const res: Response = await fetch(`${LOCAL_BASE_URL}/v1/models`);
    const body = (await res.json()) as { data?: { id?: string }[] };
    model = body.data?.[0]?.id ?? JSON.stringify(body).slice(0, 200);
  } catch {
    model = "unreachable at report time";
  }
  let serverFlags: string = "";
  try {
    const res = spawnSync("systemctl", ["--user", "cat", "llama-server.service"], { encoding: "utf-8" });
    const m: RegExpMatchArray | null = res.stdout.match(/^ExecStart=.*$/m);
    serverFlags = m ? m[0].slice(0, 2000) : "unavailable";
  } catch {
    serverFlags = "unavailable";
  }
  let patchSha: string = String(meta.usagePatchSha256 ?? "");
  if (!patchSha) {
    try {
      const bytes: string = await fs.readFile("tests/fixtures/run-code-ab/patches/usage-trace.patch", "utf-8");
      patchSha = createHash("sha256").update(bytes).digest("hex");
    } catch {
      patchSha = "unavailable";
    }
  }
  return {
    date: new Date().toISOString().slice(0, 10),
    model,
    serverFlags,
    armARef: String(meta.armARef ?? ARM_A_REF),
    armBRef: `HEAD ${(meta.armBHead as string) ?? "unknown"} + diff sha256 ${(meta.armBDiffSha256 as string) ?? "unknown"}`,
    usagePatchSha256: patchSha,
    runsPerTask: Number(meta.runsPerTask ?? n),
    timeoutSec: RUN_TIMEOUT_MS / 1000,
    serverPaused: false,
  };
}

//#endregion Report header

async function mainAsync(): Promise<void> {
  const cli: ICli = parseCli(process.argv.slice(2));
  if (cli.report) {
    const header: IReportHeader = await buildHeaderAsync(cli.out, cli.n);
    const { reportPath, summaryPath, verdict } = await writeReportAsync(RESEARCH_DIR, cli.out, header);
    console.log(`[run-code-ab] report → ${reportPath}`);
    console.log(`[run-code-ab] summary → ${summaryPath}`);
    console.log(`[run-code-ab] verdict: ${verdict.verdict} (${verdict.reasons.join("; ")})`);
    return;
  }
  if (!(await serverReachableAsync())) {
    throw new Error("CAMPAIGN-ABORTED: model server unreachable at localhost:2345/v1/models");
  }
  if (cli.arm !== null) {
    // Single-arm campaign in this process (arm-A child runs with cwd=worktree).
    await runArmInProcessAsync(cli.arm, cli.tasks, cli.n, cli.out);
    return;
  }
  // Orchestrator: task-interleaved — task T: A×n (worktree child) then B×n (here).
  await writeCampaignMeta(cli.out, cli.n);
  for (const task of cli.tasks) {
    runArmAChild(task, cli.n, cli.out);
    await runArmInProcessAsync("b", [task], cli.n, cli.out);
  }
  console.log("[run-code-ab] campaign complete. Aggregate with: npx tsx scripts/run-code-ab.ts --report");
}

mainAsync().then(() => {
  // The boot sequence leaves background handles open (timers/streams); the campaign
  // is complete when mainAsync resolves, so force exit instead of hanging.
  process.exit(0);
}).catch((error: unknown) => {
  console.error("[run-code-ab] FATAL", error instanceof Error ? error.message : error);
  process.exit(1);
});
