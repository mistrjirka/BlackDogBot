export interface LegacyCronImportEntry {
  source: string;
  sourceSha256: string;
  taskId: string;
  target: string;
}

export interface LegacyCronImportLedger {
  formatVersion: 1;
  entries: LegacyCronImportEntry[];
}

export function isSafeStoredTaskId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".."
    && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The ledger stores identities and hashes only, never task text or credentials. */
export function parseLegacyCronImportLedger(raw: unknown): LegacyCronImportLedger {
  const fail = (): never => {
    throw new Error("Invalid legacy import ledger. Restore its verified backup before upgrading.");
  };
  if (!isRecord(raw) || raw.formatVersion !== 1 || !Array.isArray(raw.entries)
    || Object.keys(raw).some(key => key !== "formatVersion" && key !== "entries")) {
    return fail();
  }

  const sources = new Set<string>();
  const targets = new Set<string>();
  const ids = new Set<string>();
  for (const entry of raw.entries) {
    if (!isRecord(entry) || !isSafeStoredTaskId(entry.taskId)
      || entry.source !== `cron/${entry.taskId}.json`
      || entry.target !== `timed/${entry.taskId}.json`
      || typeof entry.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sourceSha256)
      || Object.keys(entry).some(key => !["source", "sourceSha256", "taskId", "target"].includes(key))
      || sources.has(entry.source) || targets.has(entry.target) || ids.has(entry.taskId)) {
      return fail();
    }
    sources.add(entry.source);
    targets.add(entry.target);
    ids.add(entry.taskId);
  }

  return raw as unknown as LegacyCronImportLedger;
}
