/**
 * Phase 2 A/B harness — aggregation + AB-REPORT.md / ab-summary.json (plan §4.9).
 *
 * Reads the artifact tree (.pi-subagents/research-2026-09/ab-artifacts/) and
 * writes the report + machine-readable summary. No model, no DB access.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface IRunResultJson {
  arm: string;
  task: number;
  run: number;
  status: string;
  success: boolean;
  destructive: boolean;
  tokens: { in: number; out: number; total: number; probeTotal: number; records: number; missingUsage: number };
  relay: { totalChars: number; meanChars: number; p90Chars: number; top3: { tool: string; chars: number; jaccard: number }[] };
  resolver: { rule1: number; rule2: number; literal: number; unknown: unknown[] };
  failures: { unknown_variable: number; syntax: number; logic: number; timeout: number; error_other: number };
  steps: number;
  durationMs: number;
  timedOut: boolean;
  retried: boolean;
  finalText2000: string;
}

export interface IPerTaskSummary {
  task: number;
  medianRelayA: number;
  medianRelayB: number;
  medianBilledA: number;
  medianBilledB: number;
  successA: string;
  successB: string;
  destructiveA: number;
  destructiveB: number;
  resolverA: { rule1: number; rule2: number; literal: number; unknown: number };
  resolverB: { rule1: number; rule2: number; literal: number; unknown: number };
}

export interface IReportHeader {
  date: string;
  model: string;
  serverFlags: string;
  armARef: string;
  armBRef: string;
  usagePatchSha256: string;
  runsPerTask: number;
  timeoutSec: number;
  serverPaused: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const s: number[] = [...values].sort((a, b) => a - b);
  const mid: number = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function readResultJson(file: string): Promise<IRunResultJson | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as IRunResultJson;
  } catch {
    return null;
  }
}

export async function collectResultsAsync(artifactsDir: string): Promise<IRunResultJson[]> {
  const out: IRunResultJson[] = [];
  for (const arm of ["a", "b"]) {
    for (let task: number = 1; task <= 4; task++) {
      const taskDir: string = path.join(artifactsDir, arm, `task-${task}`);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(taskDir);
      } catch {
        continue;
      }
      for (const e of entries.sort()) {
        if (!e.startsWith("run-")) {
          continue;
        }
        const r: IRunResultJson | null = await readResultJson(path.join(taskDir, e, "result.json"));
        if (r) {
          out.push(r);
        }
      }
    }
  }
  return out;
}

export interface IVerdict {
  relayTotalA: number;
  relayTotalB: number;
  savings: number;
  billedTotalA: number;
  billedTotalB: number;
  successRateA: number;
  successRateB: number;
  destructiveB: number;
  perTask: IPerTaskSummary[];
  verdict: "B-passes" | "B-fails" | "inconclusive";
  reasons: string[];
}

export function evaluateAsync(results: IRunResultJson[]): IVerdict {
  const perTask: IPerTaskSummary[] = [];
  let relayTotalA: number = 0;
  let relayTotalB: number = 0;
  let billedTotalA: number = 0;
  let billedTotalB: number = 0;
  let successA: number = 0;
  let successB: number = 0;
  let attemptedA: number = 0;
  let attemptedB: number = 0;
  let destructiveB: number = 0;
  for (let task: number = 1; task <= 4; task++) {
    const ra: IRunResultJson[] = results.filter((r) => r.arm === "a" && r.task === task);
    const rb: IRunResultJson[] = results.filter((r) => r.arm === "b" && r.task === task);
    const medRelayA: number = median(ra.map((r) => r.relay.totalChars));
    const medRelayB: number = median(rb.map((r) => r.relay.totalChars));
    const medBillA: number = median(ra.map((r) => r.tokens.total));
    const medBillB: number = median(rb.map((r) => r.tokens.total));
    relayTotalA += medRelayA;
    relayTotalB += medRelayB;
    billedTotalA += medBillA;
    billedTotalB += medBillB;
    const okA: number = ra.filter((r) => r.success).length;
    const okB: number = rb.filter((r) => r.success).length;
    attemptedA += ra.length;
    attemptedB += rb.length;
    successA += okA;
    successB += okB;
    const destA: number = ra.filter((r) => r.destructive).length;
    const destB: number = rb.filter((r) => r.destructive).length;
    destructiveB += destB;
    const sumResolver = (rs: IRunResultJson[]): { rule1: number; rule2: number; literal: number; unknown: number } => ({
      rule1: rs.reduce((s, r) => s + r.resolver.rule1, 0),
      rule2: rs.reduce((s, r) => s + r.resolver.rule2, 0),
      literal: rs.reduce((s, r) => s + r.resolver.literal, 0),
      unknown: rs.reduce((s, r) => s + r.resolver.unknown.length, 0),
    });
    perTask.push({
      task,
      medianRelayA: medRelayA,
      medianRelayB: medRelayB,
      medianBilledA: medBillA,
      medianBilledB: medBillB,
      successA: `${okA}/${ra.length}`,
      successB: `${okB}/${rb.length}`,
      destructiveA: destA,
      destructiveB: destB,
      resolverA: sumResolver(ra),
      resolverB: sumResolver(rb),
    });
  }
  const savings: number = relayTotalA === 0 ? 0 : (relayTotalA - relayTotalB) / relayTotalA;
  const successRateA: number = attemptedA === 0 ? 0 : successA / attemptedA;
  const successRateB: number = attemptedB === 0 ? 0 : successB / attemptedB;
  const reasons: string[] = [];
  let verdict: IVerdict["verdict"];
  if (savings >= 0.25 && Math.abs(successRateB - successRateA) <= 0.1 && destructiveB === 0 && billedTotalB <= billedTotalA) {
    verdict = "B-passes";
    reasons.push(`relay savings ${(savings * 100).toFixed(1)}% ≥ 25%`);
  } else if (savings >= 0.2 && savings < 0.25) {
    verdict = "inconclusive";
    reasons.push(`relay savings ${(savings * 100).toFixed(1)}% in borderline band 20–25% — user decides (extend N or accept)`);
  } else {
    verdict = "B-fails";
    if (savings < 0.25) {
      reasons.push(`relay savings ${(savings * 100).toFixed(1)}% < 25%`);
    }
    if (Math.abs(successRateB - successRateA) > 0.1) {
      reasons.push(`success-rate gap |${successRateB.toFixed(2)} − ${successRateA.toFixed(2)}| > 0.10`);
    }
    if (destructiveB !== 0) {
      reasons.push(`destructive runs on B: ${destructiveB}`);
    }
    if (billedTotalB > billedTotalA) {
      reasons.push(`billed guard violated: B ${billedTotalB} > A ${billedTotalA}`);
    }
  }
  return { relayTotalA, relayTotalB, savings, billedTotalA, billedTotalB, successRateA, successRateB, destructiveB, perTask, verdict, reasons };
}

export function renderReportMd(header: IReportHeader, v: IVerdict, results: IRunResultJson[]): string {
  const lines: string[] = [];
  lines.push("# Phase 2 A/B Report — Arms A (baseline) vs B (Phase 1)");
  lines.push("");
  lines.push(`Date: ${header.date}`);
  lines.push(`Model: ${header.model}`);
  lines.push(`Server flags: ${header.serverFlags}`);
  lines.push(`Arm A ref: ${header.armARef}`);
  lines.push(`Arm B ref: ${header.armBRef}`);
  lines.push(`usage-trace.patch sha256: ${header.usagePatchSha256}`);
  lines.push(`N per task per arm: ${header.runsPerTask}; per-run timeout: ${header.timeoutSec}s`);
  lines.push(`blackdogbot daemon paused during campaign: ${header.serverPaused ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Per-task medians");
  lines.push("");
  lines.push("| task | A relay | B relay | Δ relay | A billed | B billed | A succ | B succ | A destr | B destr | A resolver (r1/r2/lit/unk) | B resolver (r1/r2/lit/unk) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of v.perTask) {
    const delta: string = t.medianRelayA === 0 ? "n/a" : `${(((t.medianRelayA - t.medianRelayB) / t.medianRelayA) * 100).toFixed(1)}%`;
    lines.push(
      `| ${t.task} | ${t.medianRelayA.toFixed(0)} | ${t.medianRelayB.toFixed(0)} | ${delta} | ` +
      `${t.medianBilledA.toFixed(0)} | ${t.medianBilledB.toFixed(0)} | ${t.successA} | ${t.successB} | ` +
      `${t.destructiveA} | ${t.destructiveB} | ` +
      `${t.resolverA.rule1}/${t.resolverA.rule2}/${t.resolverA.literal}/${t.resolverA.unknown} | ` +
      `${t.resolverB.rule1}/${t.resolverB.rule2}/${t.resolverB.literal}/${t.resolverB.unknown} |`,
    );
  }
  lines.push("");
  lines.push("## Totals + verdict");
  lines.push("");
  lines.push(`- relayTotal A=${v.relayTotalA.toFixed(0)} B=${v.relayTotalB.toFixed(0)} savings=${(v.savings * 100).toFixed(1)}%`);
  lines.push(`- billedTotal A=${v.billedTotalA.toFixed(0)} B=${v.billedTotalB.toFixed(0)}`);
  lines.push(`- successRate A=${v.successRateA.toFixed(2)} B=${v.successRateB.toFixed(2)}; destructive B total=${v.destructiveB}`);
  lines.push(`- verdict: ${v.verdict} (${v.reasons.join("; ")})`);
  lines.push(`- ${v.verdict === "B-passes" ? "B-passes → ship B" : v.verdict === "B-fails" ? "B-fails → Phase 3 (arm C)" : "inconclusive → user decides (extend N or accept)"}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Arm-B system prompt is ~13 lines (~900 chars, ~200 tok/step) larger than arm A (the shipped `<stored_variables>` section); included in the comparison, not subtracted.");
  lines.push("- Probe (capability-check) requests are included in token totals on both arms (symmetric fresh-HOME boot); probeTokens reported separately per run.");
  lines.push("- prompt_tokens is KV-cache-independent; only cached_tokens varies and it is ignored.");
  lines.push("");
  lines.push("## Per-run appendix");
  lines.push("");
  lines.push("| arm | task | run | status | success | destr | tokens in/out/total | relay chars | steps | dur ms | timedOut | retried |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const sorted: IRunResultJson[] = [...results].sort((a, b) =>
    a.arm === b.arm ? (a.task === b.task ? a.run - b.run : a.task - b.task) : a.arm < b.arm ? -1 : 1,
  );
  for (const r of sorted) {
    lines.push(
      `| ${r.arm} | ${r.task} | ${r.run} | ${r.status} | ${r.success} | ${r.destructive} | ` +
      `${r.tokens.in}/${r.tokens.out}/${r.tokens.total} | ${r.relay.totalChars.toFixed(0)} | ` +
      `${r.steps} | ${r.durationMs} | ${r.timedOut} | ${r.retried} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeReportAsync(
  researchDir: string,
  artifactsDir: string,
  header: IReportHeader,
): Promise<{ reportPath: string; summaryPath: string; verdict: IVerdict }> {
  const results: IRunResultJson[] = await collectResultsAsync(artifactsDir);
  const verdict: IVerdict = evaluateAsync(results);
  const md: string = renderReportMd(header, verdict, results);
  const reportPath: string = path.join(researchDir, "AB-REPORT.md");
  const summaryPath: string = path.join(researchDir, "ab-summary.json");
  await fs.writeFile(reportPath, md, "utf-8");
  await fs.writeFile(
    summaryPath,
    JSON.stringify({ header, verdict, runs: results }, null, 2),
    "utf-8",
  );
  return { reportPath, summaryPath, verdict };
}
