import path from "node:path";
import { parseArgs } from "node:util";
import { getBaseDir } from "../utils/paths.js";
import { applyBackupRetentionAsync, BackupRetentionError, planBackupRetentionAsync } from "./backup-retention.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: false, strict: true,
    options: {
      "data-dir": { type: "string" }, "backup-root": { type: "string" }, state: { type: "string" },
      keep: { type: "string" }, "min-age-days": { type: "string" },
      apply: { type: "boolean", default: false }, "recover-lock": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(JSON.stringify({ protocolVersion: 1, usage: "backup:prune [--data-dir ABS] [--backup-root ABS] [--state ABS] [--keep 3] [--min-age-days 14] [--apply] [--recover-lock]", default: "Read-only preview. --apply deletes only eligible verified snapshots." }) + "\n");
    return;
  }
  if (positionals.length) throw new BackupRetentionError("Unexpected positional arguments.");
  if (values["recover-lock"] && !values.apply) throw new BackupRetentionError("--recover-lock requires --apply.");
  const dataDir = values["data-dir"] ?? getBaseDir();
  if (!path.isAbsolute(dataDir)) throw new BackupRetentionError("--data-dir requires an absolute path.");
  const options = {
    dataDir, backupRoot: values["backup-root"], stateDir: values.state,
    keep: values.keep === undefined ? undefined : Number(values.keep),
    minAgeDays: values["min-age-days"] === undefined ? undefined : Number(values["min-age-days"]),
    recoverLock: values["recover-lock"],
  };
  const result = values.apply ? await applyBackupRetentionAsync(options) : await planBackupRetentionAsync(options);
  process.stdout.write(JSON.stringify(result) + "\n");
}
main().catch((error: unknown) => {
  const trusted = error instanceof Error && ["BackupRetentionError", "DataLockError"].includes(error.name);
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, status: "failed",
    error: trusted ? (error as Error).message : "Backup cleanup failed. Preserve its receipt and any retirement directory before retrying.",
  }) + "\n");
  process.exitCode = 1;
});
