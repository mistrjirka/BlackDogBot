import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryExistsAsync, getLogsDir } from "../../utils/paths.js";

const LLM_TRACE_ENV_VAR: string = "BLACKDOG_LOG_LLM";
const LLM_TRACE_DEFAULT_FILE_NAME: string = "llm-trace.jsonl";
const _ensuredDirs: Set<string> = new Set();

/**
 * Cap for the response text kept in a trace record. Responses are capped but
 * request bodies are kept in full on purpose: request construction (tools,
 * injected parameters, message serialization) is what the trace diagnoses,
 * and requests are bounded by the context-window hard gate. The trace has no
 * rotation — it is an opt-in diagnostic; unset BLACKDOG_LOG_LLM when done.
 */
export const LLM_TRACE_MAX_RESPONSE_CHARS: number = 6000;

/**
 * One JSONL line per traced (non-streaming) LLM request.
 */
export interface ILlmTraceRecord {
  ts: string;
  provider: string;
  url: string;
  method: string;
  status: number;
  requestBody: unknown;
  response: string | null;
  responseTruncated: boolean;
}

/**
 * Resolves the LLM trace file path from the BLACKDOG_LOG_LLM env var:
 * unset/empty → null (disabled), "true"/"1"/"on" → <logs dir>/llm-trace.jsonl,
 * anything else → the value used as an explicit file path.
 */
export function resolveLlmTraceFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw: string | undefined = env[LLM_TRACE_ENV_VAR];
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  const value: string = raw.trim();
  if (value === "true" || value === "1" || value === "on") {
    return path.join(getLogsDir(), LLM_TRACE_DEFAULT_FILE_NAME);
  }

  return value;
}

/**
 * Appends a trace record as one JSONL line. Returns the file path written to,
 * or null when tracing is disabled.
 */
export async function appendLlmTraceRecordAsync(
  record: ILlmTraceRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const filePath: string | null = resolveLlmTraceFilePath(env);
  if (filePath === null) {
    return null;
  }

  const dir: string = path.dirname(filePath);
  if (!_ensuredDirs.has(dir)) {
    await ensureDirectoryExistsAsync(dir);
    _ensuredDirs.add(dir);
  }

  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
  return filePath;
}
