/**
 * Phase 2 A/B harness — pure metric functions (plan §4.2–4.5, §4.7).
 *
 * Every export here is a pure function: no model, no filesystem (callers pass
 * parsed JSONL records / db dumps). Unit-tested in metrics.test.ts.
 */

//#region Trace record shapes

export interface ITraceUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ITraceRecordLike {
  usage?: ITraceUsage | null;
  response?: string | null;
  responseTruncated?: boolean;
  requestBody?: unknown;
  status?: number;
}

export interface IWireToolCall {
  id: string;
  name: string;
  argsString: string;
}

export interface IRelayCallScore {
  tool: string;
  chars: number;
  jaccard: number;
}

export interface IRelayReport {
  totalChars: number;
  meanChars: number;
  p90Chars: number;
  top3: IRelayCallScore[];
  callCount: number;
}

export interface ITokenReport {
  in: number;
  out: number;
  total: number;
  probeTotal: number;
  records: number;
  missingUsage: number;
}

export interface IResolverReport {
  rule1: number;
  rule2: number;
  literal: number;
  unknown: unknown[];
}

//#endregion Trace record shapes

//#region Parsing helpers

/** Parse one JSONL line; null on blank/unparseable. */
export function parseTraceLine(line: string): ITraceRecordLike | null {
  if (!line.trim()) {
    return null;
  }
  try {
    return JSON.parse(line) as ITraceRecordLike;
  } catch {
    return null;
  }
}

/** Usage for one record: post-patch field, else pre-patch response fallback. */
export function usageOfRecord(rec: ITraceRecordLike): ITraceUsage | null {
  if (rec.usage !== undefined && rec.usage !== null) {
    return rec.usage;
  }
  if (typeof rec.response === "string" && rec.response.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rec.response);
      const candidate = (parsed as { usage?: unknown })?.usage;
      if (candidate !== null && typeof candidate === "object") {
        return candidate as ITraceUsage;
      }
    } catch {
      // truncated/unparseable — usage lost (the pre-patch failure mode)
    }
  }
  return null;
}

/** Heuristic: capability-probe requests carry no tool definitions. */
function isProbeRequest(requestBody: unknown): boolean {
  if (!requestBody || typeof requestBody !== "object") {
    return false;
  }
  const body = requestBody as Record<string, unknown>;
  return body.tools === undefined && body.tool_choice === undefined;
}

//#endregion Parsing helpers

//#region (a) Token totals — plan §4.2

export function tokenTotals(records: ITraceRecordLike[]): ITokenReport {
  let input: number = 0;
  let output: number = 0;
  let probeTotal: number = 0;
  let missingUsage: number = 0;
  for (const rec of records) {
    const u: ITraceUsage | null = usageOfRecord(rec);
    if (!u) {
      missingUsage++;
      continue;
    }
    const recIn: number = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
    const recOut: number = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
    input += recIn;
    output += recOut;
    if (isProbeRequest(rec.requestBody)) {
      probeTotal += recIn + recOut;
    }
  }
  return { in: input, out: output, total: input + output, probeTotal, records: records.length, missingUsage };
}

//#endregion (a)

//#region (b) Relay — plan §4.3 (units = chars)

/**
 * Ordered call list from trace records (OpenAI-compatible wire format:
 * assistant messages carry tool_calls[] with function.arguments as raw strings).
 * First request body containing a given call id wins (emission-time context).
 */
export function collectWireCalls(records: ITraceRecordLike[]): { calls: IWireToolCall[]; priors: string[][] } {
  const seen: Set<string> = new Set();
  const calls: IWireToolCall[] = [];
  const priors: string[][] = [];
  for (const rec of records) {
    const body = rec.requestBody as { messages?: unknown } | null | undefined;
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      continue;
    }
    const messages = body.messages as Record<string, unknown>[];
    for (let m: number = 0; m < messages.length; m++) {
      const msg = messages[m];
      if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
        continue;
      }
      const toolCalls: unknown = msg.tool_calls;
      if (!Array.isArray(toolCalls)) {
        continue;
      }
      // prior(C) = tool-message contents appearing BEFORE this assistant message
      const priorContents: string[] = [];
      for (let k: number = 0; k < m; k++) {
        const earlier = messages[k];
        if (earlier && typeof earlier === "object" && earlier.role === "tool") {
          const content: unknown = earlier.content;
          if (typeof content === "string" && content.length > 0) {
            priorContents.push(content);
          }
        }
      }
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") {
          continue;
        }
        const entry = tc as { id?: unknown; function?: unknown };
        const fn = entry.function as { name?: unknown; arguments?: unknown } | undefined;
        const id: unknown = entry.id;
        const name: unknown = fn?.name;
        const args: unknown = fn?.arguments;
        if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") {
          continue;
        }
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        calls.push({ id, name, argsString: args });
        priors.push(priorContents);
      }
    }
  }
  return { calls, priors };
}

function grams5(s: string): Set<string> {
  if (s.length < 5) {
    return new Set([s]);
  }
  const out: Set<string> = new Set();
  for (let i: number = 0; i + 5 <= s.length; i++) {
    out.add(s.slice(i, i + 5));
  }
  return out;
}

/** 5-gram Jaccard similarity (plan §4.3 step 3). Empty union → 0. */
export function jaccard5(a: string, b: string): number {
  const ga: Set<string> = grams5(a);
  const gb: Set<string> = grams5(b);
  if (ga.size === 0 && gb.size === 0) {
    return 0;
  }
  let inter: number = 0;
  for (const g of ga) {
    if (gb.has(g)) {
      inter++;
    }
  }
  const union: number = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** relay(C) = max over prior tool results of J5(args, r) × args.length. */
export function relayOfCall(argsString: string, priorContents: string[]): { chars: number; jaccard: number } {
  if (priorContents.length === 0 || argsString.length === 0) {
    return { chars: 0, jaccard: 0 };
  }
  let best: number = 0;
  for (const r of priorContents) {
    const j: number = jaccard5(argsString, r);
    if (j > best) {
      best = j;
    }
  }
  return { chars: best * argsString.length, jaccard: best };
}

export function relayReport(records: ITraceRecordLike[]): IRelayReport {
  const { calls, priors } = collectWireCalls(records);
  const scores: IRelayCallScore[] = calls.map((c, i) => {
    const { chars, jaccard } = relayOfCall(c.argsString, priors[i]);
    return { tool: c.name, chars, jaccard };
  });
  const totalChars: number = scores.reduce((s, x) => s + x.chars, 0);
  const meanChars: number = scores.length === 0 ? 0 : totalChars / scores.length;
  const sorted: number[] = scores.map((s) => s.chars).sort((a, b) => a - b);
  const p90Chars: number =
    sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
  const top3: IRelayCallScore[] = [...scores].sort((a, b) => b.chars - a.chars).slice(0, 3);
  return { totalChars, meanChars, p90Chars, top3, callCount: scores.length };
}

//#endregion (b)

//#region (c) Resolver branches — plan §4.4 (derived from wire format)

export type ResolverBranch = "rule1" | "rule2" | "literal" | "other";

function isVariableRefObject(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const keys: string[] = Object.keys(v);
  return (
    keys.length === 2 &&
    (v as Record<string, unknown>).type === "variable" &&
    typeof (v as Record<string, unknown>).name === "string"
  );
}

/** Classify one write-call argument value into a resolver branch. */
export function classifyResolverValue(value: unknown): ResolverBranch {
  if (isVariableRefObject(value)) {
    return "rule1";
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isVariableRefObject(parsed)) {
        return "rule2";
      }
    } catch {
      // not JSON — falls through
    }
    return "other";
  }
  if (Array.isArray(value)) {
    return "literal";
  }
  return "other";
}

const REF_FIELDS: ReadonlySet<string> = new Set(["data", "content", "knowledge"]);

/**
 * Walk wire calls; for each call whose parsed arguments object has a field in
 * {data, content, knowledge}, classify the field value. Also scans tool-message
 * contents for unknown_variable error payloads.
 */
export function resolverReport(records: ITraceRecordLike[]): IResolverReport {
  const { calls } = collectWireCalls(records);
  let rule1: number = 0;
  let rule2: number = 0;
  let literal: number = 0;
  for (const c of calls) {
    let args: unknown;
    try {
      args = JSON.parse(c.argsString);
    } catch {
      continue;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      continue;
    }
    for (const field of REF_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(args, field)) {
        const branch: ResolverBranch = classifyResolverValue(
          (args as Record<string, unknown>)[field],
        );
        if (branch === "rule1") {
          rule1++;
        } else if (branch === "rule2") {
          rule2++;
        } else if (branch === "literal") {
          literal++;
        }
        break;
      }
    }
  }
  const unknown: unknown[] = [];
  for (const rec of records) {
    const body = rec.requestBody as { messages?: unknown } | null | undefined;
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      continue;
    }
    for (const msg of body.messages as Record<string, unknown>[]) {
      if (!msg || typeof msg !== "object" || msg.role !== "tool") {
        continue;
      }
      const content: unknown = msg.content;
      if (typeof content !== "string") {
        continue;
      }
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed && parsed.ok === false && parsed.error === "unknown_variable") {
          unknown.push(parsed);
        }
      } catch {
        // plain-text tool result — not an unknown_variable payload
      }
    }
  }
  return { rule1, rule2, literal, unknown };
}

//#endregion (c)

//#region (d) Failure classification — plan §4.5

export type FailureKind = "unknown_variable" | "syntax" | "logic" | "timeout" | "error_other";

const SYNTAX_RE: RegExp = /expected|invalid|required|must be|not a function|schema/i;

/** True when a tool-result/step error text is a validation-shape error (not unknown_variable). */
export function isSyntaxErrorText(text: string): boolean {
  if (/unknown_variable/.test(text)) {
    return false;
  }
  return SYNTAX_RE.test(text);
}

//#endregion (d)

//#region (e) DB dump + destructive diff — plan §4.7

export type DbDump = Record<string, Record<string, unknown>[]>;

function normalizeRows(rows: Record<string, unknown>[]): string[] {
  return rows.map((r) => JSON.stringify(sortKeys(r))).sort();
}

function sortKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) {
    out[k] = row[k];
  }
  return out;
}

export interface IDestructiveDiff {
  destructive: boolean;
  addedTables: string[];
  droppedTables: string[];
  changedTables: string[];
}

/**
 * Destructive iff: a table was added (targets pre-exist, so never allowed),
 * a table was dropped, or a NON-allowed table's rows differ. Differences inside
 * an allowed table are judged by the success criterion, not here.
 */
export function destructiveDiff(
  before: DbDump,
  after: DbDump,
  allowedTables: string[],
): IDestructiveDiff {
  const allowed: Set<string> = new Set(allowedTables);
  const addedTables: string[] = [];
  const droppedTables: string[] = [];
  const changedTables: string[] = [];
  for (const t of Object.keys(after)) {
    if (!(t in before) && !allowed.has(t)) {
      addedTables.push(t);
    }
  }
  for (const t of Object.keys(before)) {
    if (!(t in after)) {
      droppedTables.push(t);
    }
  }
  for (const t of Object.keys(before)) {
    if (!(t in after) || allowed.has(t)) {
      continue;
    }
    const b: string[] = normalizeRows(before[t]);
    const a: string[] = normalizeRows(after[t]);
    if (b.length !== a.length || b.some((row, i) => row !== a[i])) {
      changedTables.push(t);
    }
  }
  return {
    destructive: addedTables.length > 0 || droppedTables.length > 0 || changedTables.length > 0,
    addedTables,
    droppedTables,
    changedTables,
  };
}

/** Order-normalized deep-equality of two row sets (by id when present). */
export function rowsEqual(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const keyOf = (r: Record<string, unknown>): string =>
    "id" in r ? `id:${String(r.id)}` : JSON.stringify(sortKeys(r));
  const sortedA: Record<string, unknown>[] = [...a].sort((x, y) =>
    keyOf(x) < keyOf(y) ? -1 : 1,
  );
  const sortedB: Record<string, unknown>[] = [...b].sort((x, y) =>
    keyOf(x) < keyOf(y) ? -1 : 1,
  );
  return sortedA.every((row, i) => JSON.stringify(sortKeys(row)) === JSON.stringify(sortKeys(sortedB[i])));
}

/** First divergence description for failure payloads (plan §4.5 logic). */
export function firstDivergence(
  actual: Record<string, unknown>[],
  expected: Record<string, unknown>[],
): string {
  if (actual.length !== expected.length) {
    return `row count differs: actual ${actual.length}, expected ${expected.length}`;
  }
  const keyOf = (r: Record<string, unknown>): string =>
    "id" in r ? `id:${String(r.id)}` : JSON.stringify(sortKeys(r));
  const expByKey: Map<string, string> = new Map(
    expected.map((r) => [keyOf(r), JSON.stringify(sortKeys(r))]),
  );
  for (const row of actual) {
    const k: string = keyOf(row);
    const exp: string | undefined = expByKey.get(k);
    const got: string = JSON.stringify(sortKeys(row));
    if (exp === undefined) {
      return `unexpected row ${got.slice(0, 300)}`;
    }
    if (exp !== got) {
      return `row ${k} differs: got ${got.slice(0, 300)}, want ${exp.slice(0, 300)}`;
    }
  }
  return "no divergence (order-only difference)";
}

//#endregion (e)
