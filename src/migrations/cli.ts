import path from "node:path";
import { parseArgs } from "node:util";
import { getBaseDir } from "../utils/paths.js";
import {
  applyDataMigrationAsync, DataMigrationError, planDataMigrationAsync,
  recoverDataMigrationAsync, rollbackDataMigrationAsync,
} from "./data-migrations.js";
import {
  createDataBackupAsync, planDataBackupAsync, restoreDataBackupAsync, verifyDataBackupAsync,
} from "./data-backups.js";

const commands = ["plan", "apply", "rollback", "recover", "backup-create", "backup-verify", "backup-restore"] as const;
const usage = {
  plan: "plan [--data-dir PATH] [--import-legacy-tasks]",
  apply: "apply [--data-dir PATH] [--import-legacy-tasks] --offline",
  rollback: "rollback [--data-dir PATH] --transaction ID --offline",
  recover: "recover [--data-dir PATH] --offline",
  "backup-create": "backup-create [--data-dir PATH] --backup-dir NEW_PATH --offline",
  "backup-verify": "backup-verify --backup-dir PATH",
  "backup-restore": "backup-restore --backup-dir PATH --destination NEW_PATH --offline",
};

function absolute(value: string | undefined, option: string): string {
  if (!value || !path.isAbsolute(value)) throw new DataMigrationError(`${option} requires an absolute path.`);
  return path.resolve(value);
}

async function mainAsync(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      "data-dir": { type: "string" },
      transaction: { type: "string" },
      offline: { type: "boolean", default: false },
      "import-legacy-tasks": { type: "boolean", default: false },
      "backup-dir": { type: "string" },
      destination: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(JSON.stringify({ protocolVersion: 1, usage }) + "\n");
    return;
  }
  const command = positionals[0] as typeof commands[number];
  if (positionals.length !== 1 || !commands.includes(command)) {
    throw new DataMigrationError(`Usage: migrate <${commands.join("|")}>. Use --help for arguments.`);
  }
  if (!["plan", "backup-verify"].includes(command) && !values.offline) {
    throw new DataMigrationError("Stop every process that writes this data directory, then repeat with --offline. The flag confirms that legacy writers are stopped.");
  }
  if (command === "rollback" && !values.transaction) {
    throw new DataMigrationError("Rollback requires --transaction ID from the migration receipt.");
  }
  if (command !== "rollback" && values.transaction) throw new DataMigrationError("--transaction is only valid for rollback.");
  if (values["import-legacy-tasks"] && command !== "plan" && command !== "apply") {
    throw new DataMigrationError("--import-legacy-tasks is only valid for plan or apply.");
  }
  if (!command.startsWith("backup-") && values["backup-dir"]) {
    throw new DataMigrationError("--backup-dir is only valid for backup commands.");
  }
  if (command !== "backup-restore" && values.destination) {
    throw new DataMigrationError("--destination is only valid for backup-restore.");
  }
  if (["backup-verify", "backup-restore"].includes(command) && values["data-dir"]) {
    throw new DataMigrationError("Verification and staged restore use --backup-dir, not --data-dir.");
  }

  const migrationOptions = { importLegacyTasks: values["import-legacy-tasks"] };
  let result: unknown;
  if (command === "backup-verify") {
    result = await verifyDataBackupAsync(absolute(values["backup-dir"], "--backup-dir"));
  } else if (command === "backup-restore") {
    result = await restoreDataBackupAsync(
      absolute(values["backup-dir"], "--backup-dir"),
      absolute(values.destination, "--destination"),
    );
  } else {
    const dataDir = absolute(values["data-dir"] ?? getBaseDir(), "--data-dir");
    switch (command) {
      case "plan": {
        const plan = await planDataMigrationAsync(dataDir, migrationOptions);
        try {
          const backupPlan = await planDataBackupAsync(dataDir);
          result = { ...plan, backupProtocolVersion: 1, backupReady: true, backupPlan };
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "DataBackupError") throw error;
          result = { ...plan, backupProtocolVersion: 1, backupReady: false, backupIssue: error.message };
        }
        break;
      }
      case "apply": result = await applyDataMigrationAsync(dataDir, migrationOptions); break;
      case "rollback": result = await rollbackDataMigrationAsync(dataDir, values.transaction!); break;
      case "recover": result = await recoverDataMigrationAsync(dataDir); break;
      case "backup-create":
        result = await createDataBackupAsync(dataDir, absolute(values["backup-dir"], "--backup-dir"));
        break;
    }
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
mainAsync().catch((error: unknown) => {
  // Only explicitly sanitized domain errors may be sent to an external updater.
  // Never serialize configuration, task contents, or native library diagnostics.
  const safeDomainError = error instanceof Error && ["DataLockError", "DataBackupError"].includes(error.name);
  const message = error instanceof DataMigrationError || safeDomainError ? (error as Error).message
    : `Migration command failed (${(error as NodeJS.ErrnoException)?.code ?? "unexpected error"}). Keep the service stopped and inspect the migration journal.`;
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, status: "failed", error: message,
    ...(error instanceof DataMigrationError && error.transactionId ? { transactionId: error.transactionId } : {}),
  }) + "\n");
  process.exitCode = 1;
});
