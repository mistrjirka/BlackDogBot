import path from "node:path";
import { parseArgs } from "node:util";
import { getBaseDir } from "../utils/paths.js";
import {
  applyDataMigrationAsync, DataMigrationError, planDataMigrationAsync,
  recoverDataMigrationAsync, rollbackDataMigrationAsync,
} from "./data-migrations.js";
import {
  createDataBackupAsync, DataBackupError, planDataBackupAsync, planDataBackupAfterPathMigrationAsync,
  restoreDataBackupAsync, verifyDataBackupAsync,
} from "./data-backups.js";
import {
  applyDatabasePathMigrationAsync, DatabasePathMigrationError, planDatabasePathMigrationAsync,
  recoverDatabasePathMigrationAsync, rollbackDatabasePathMigrationAsync,
} from "./database-path-migrations.js";

const capabilities = { protocolVersion: 1, backupProtocolVersion: 1, pathMigrationProtocolVersion: 1, activationProtocolVersion: 1 } as const;
const commands = ["plan", "apply", "rollback", "recover", "backup-create", "backup-verify", "backup-restore",
  "paths-plan", "paths-apply", "paths-rollback", "paths-recover"] as const;
const usage = {
  plan: "plan [--data-dir PATH] [--import-legacy-tasks] [--runtime-cwd PATH] [--source PATH]",
  apply: "apply [--data-dir PATH] [--import-legacy-tasks] --offline",
  rollback: "rollback [--data-dir PATH] --transaction ID --offline",
  recover: "recover [--data-dir PATH] --offline",
  "backup-create": "backup-create [--data-dir PATH] --backup-dir NEW_PATH --offline",
  "backup-verify": "backup-verify --backup-dir PATH",
  "backup-restore": "backup-restore --backup-dir PATH --destination NEW_PATH --offline",
  "paths-plan": "paths-plan [--data-dir PATH] [--runtime-cwd PATH] [--source PATH]",
  "paths-apply": "paths-apply [--data-dir PATH] [--runtime-cwd PATH] [--source PATH] --offline",
  "paths-rollback": "paths-rollback [--data-dir PATH] --transaction ID --offline",
  "paths-recover": "paths-recover [--data-dir PATH] --offline",
};

function absolute(value: string | undefined, option: string): string {
  if (!value || !path.isAbsolute(value)) throw new DataMigrationError(option + " requires an absolute path.");
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
      "runtime-cwd": { type: "string" },
      source: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(JSON.stringify({ ...capabilities, usage }) + "\n");
    return;
  }
  const command = positionals[0] as typeof commands[number];
  if (positionals.length !== 1 || !commands.includes(command)) {
    throw new DataMigrationError("Usage: migrate <" + commands.join("|") + ">. Use --help for arguments.");
  }
  if (!["plan", "paths-plan", "backup-verify"].includes(command) && !values.offline) {
    throw new DataMigrationError("Stop every process that writes this data directory, then repeat with --offline. The flag confirms that legacy writers are stopped.");
  }
  if (["rollback", "paths-rollback"].includes(command) && !values.transaction) {
    throw new DataMigrationError("Rollback requires --transaction ID from the migration receipt.");
  }
  if (!["rollback", "paths-rollback"].includes(command) && values.transaction) throw new DataMigrationError("--transaction is only valid for rollback or paths-rollback.");
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
  if ((values["runtime-cwd"] || values.source) && !["plan", "paths-plan", "paths-apply"].includes(command)) {
    throw new DataMigrationError("--runtime-cwd and --source are only valid for plan, paths-plan, or paths-apply.");
  }
  const pathOptions = {
    ...(values["runtime-cwd"] ? { runtimeCwd: absolute(values["runtime-cwd"], "--runtime-cwd") } : {}),
    ...(values.source ? { sourcePath: absolute(values.source, "--source") } : {}),
  };
  const migrationOptions = { importLegacyTasks: values["import-legacy-tasks"] };
  let result: unknown;
  if (command === "backup-verify") {
    result = await verifyDataBackupAsync(absolute(values["backup-dir"], "--backup-dir"));
  } else if (command === "backup-restore") {
    result = await restoreDataBackupAsync(absolute(values["backup-dir"], "--backup-dir"), absolute(values.destination, "--destination"));
  } else {
    const dataDir = absolute(values["data-dir"] ?? getBaseDir(), "--data-dir");
    switch (command) {
      case "plan": {
        const databasePathMigration = await planDatabasePathMigrationAsync(dataDir, pathOptions);
        const plan = await planDataMigrationAsync(dataDir, migrationOptions);
        try {
          const backupPlan = await planDataBackupAsync(dataDir);
          result = { ...plan, ...capabilities, databasePathMigration, backupReady: true, preBackupMigrationReady: false, backupPlan };
        } catch (error) {
          if (!(error instanceof DataBackupError)) throw error;
          let preBackupMigrationReady = false;
          let postPathMigrationBackupPlan;
          if (databasePathMigration.needsMigration) {
            try {
              postPathMigrationBackupPlan = await planDataBackupAfterPathMigrationAsync(dataDir, databasePathMigration.destinationPath);
              preBackupMigrationReady = true;
            } catch (coverageError) {
              if (!(coverageError instanceof DataBackupError)) throw coverageError;
            }
          }
          result = { ...plan, ...capabilities, databasePathMigration, backupReady: false,
            backupIssue: error.message, preBackupMigrationReady,
            ...(postPathMigrationBackupPlan ? { postPathMigrationBackupPlan } : {}) };
        }
        break;
      }
      case "apply": result = await applyDataMigrationAsync(dataDir, migrationOptions); break;
      case "rollback": result = await rollbackDataMigrationAsync(dataDir, values.transaction!); break;
      case "recover": result = await recoverDataMigrationAsync(dataDir); break;
      case "backup-create": result = await createDataBackupAsync(dataDir, absolute(values["backup-dir"], "--backup-dir")); break;
      case "paths-plan": result = await planDatabasePathMigrationAsync(dataDir, pathOptions); break;
      case "paths-apply": result = await applyDatabasePathMigrationAsync(dataDir, pathOptions); break;
      case "paths-rollback": result = await rollbackDatabasePathMigrationAsync(dataDir, values.transaction!); break;
      case "paths-recover": result = await recoverDatabasePathMigrationAsync(dataDir); break;
    }
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
mainAsync().catch((error: unknown) => {
  // Only explicitly sanitized domain errors may reach an external updater.
  const safeDomainError = error instanceof Error && ["DataLockError", "DataBackupError"].includes(error.name);
  const migrationError = error instanceof DataMigrationError || error instanceof DatabasePathMigrationError;
  const message = migrationError || safeDomainError ? (error as Error).message
    : "Migration command failed (" + ((error as NodeJS.ErrnoException)?.code ?? "unexpected error") + "). Keep the service stopped and inspect the migration journal.";
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, status: "failed", error: message,
    ...(migrationError && error.transactionId ? { transactionId: error.transactionId } : {}),
    ...(error instanceof DatabasePathMigrationError && error.candidates ? { databasePathCandidates: error.candidates } : {}),
  }) + "\n");
  process.exitCode = 1;
});
