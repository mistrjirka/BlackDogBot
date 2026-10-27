/**
 * Centralized, environment-configurable limits.
 *
 * Every limit that is surfaced to the model (tool schema descriptions, system
 * context) must come from this module so code and prompts cannot drift.
 */

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw: string = (process.env[name] ?? "").trim();
  if (raw.length === 0) {
    return fallback;
  }

  const parsed: number = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

/** Tool results above this many characters are stored as blackboard variables. */
export const CAPTURE_THRESHOLD_CHARS: number = readIntEnv(
  "BLACKDOGBOT_CAPTURE_THRESHOLD_CHARS",
  4000,
  500,
  200_000,
);

/** Maximum characters shown in a stored-result stub preview. */
export const PREVIEW_MAX_CHARS: number = readIntEnv(
  "BLACKDOGBOT_PREVIEW_MAX_CHARS",
  1200,
  100,
  50_000,
);

/** Maximum model-requested visible output for one run_code call. */
export const RUN_CODE_MAX_OUTPUT_CHARS: number = readIntEnv(
  "BLACKDOGBOT_RUN_CODE_MAX_OUTPUT_CHARS", 16_000, 500, 16_000,
);

/** Default run_code display budget; per-call maxOutputChars can override it. */
export const RUN_CODE_DEFAULT_OUTPUT_CHARS: number = Math.min(
  RUN_CODE_MAX_OUTPUT_CHARS,
  readIntEnv("BLACKDOGBOT_RUN_CODE_DEFAULT_OUTPUT_CHARS", 3000, 500, 16_000),
);

/** Bounded in-worker print buffer, retained for inspect_variable continuation. */
export const RUN_CODE_OUTPUT_BUFFER_CHARS = 64_000;

/** Hard cap per inspect_variable call. */
export const INSPECT_VARIABLE_MAX_CHARS: number = readIntEnv(
  "BLACKDOGBOT_INSPECT_VARIABLE_MAX_CHARS",
  24_000,
  100,
  200_000,
);

/** Default slice size for inspect_variable. */
export const INSPECT_VARIABLE_DEFAULT_CHARS: number = Math.min(
  INSPECT_VARIABLE_MAX_CHARS,
  readIntEnv("BLACKDOGBOT_INSPECT_VARIABLE_DEFAULT_CHARS", 4000, 1, 200_000),
);

/** Default row limit for read_from_database (hard max 50). */
export const READ_DB_DEFAULT_LIMIT: number = readIntEnv(
  "BLACKDOGBOT_READ_DB_DEFAULT_LIMIT",
  20,
  1,
  50,
);

/** Main-agent step budget per generation attempt. */
export const MAIN_AGENT_MAX_STEPS: number = readIntEnv(
  "BLACKDOGBOT_MAIN_AGENT_MAX_STEPS",
  300,
  1,
  10_000,
);

/** Cron-agent step budget per generation attempt. */
export const CRON_AGENT_MAX_STEPS: number = readIntEnv(
  "BLACKDOGBOT_CRON_AGENT_MAX_STEPS",
  300,
  1,
  10_000,
);

export function formatCharLimit(value: number): string {
  return value.toLocaleString("en-US");
}
