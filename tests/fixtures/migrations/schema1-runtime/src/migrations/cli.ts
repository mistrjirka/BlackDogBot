import path from "node:path";
import { parseArgs } from "node:util";
import { getBaseDir } from "../utils/paths.js";
import {
  applyDataMigrationAsync, DataMigrationError, planDataMigrationAsync,
  recoverDataMigrationAsync, rollbackDataMigrationAsync,
} from "./data-migrations.js";

async function mainAsync(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      transaction: { type: "string" },
      offline: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !["plan", "apply", "rollback", "recover"].includes(command)) {
    throw new DataMigrationError("Usage: migrate <plan|apply|rollback|recover> [--data-dir ABSOLUTE_PATH] [--offline] [--transaction ID]");
  }
  if (command !== "plan" && !values.offline) {
    throw new DataMigrationError("Stop every process that writes this data directory, then repeat with --offline. The flag confirms that legacy writers are stopped.");
  }
  if (command === "rollback" && !values.transaction) {
    throw new DataMigrationError("Rollback requires --transaction ID from the migration receipt.");
  }
  if (command !== "rollback" && values.transaction) {
    throw new DataMigrationError("--transaction is only valid for rollback.");
  }
  const dataDir = values["data-dir"] ?? getBaseDir();
  if (!path.isAbsolute(dataDir)) throw new DataMigrationError("--data-dir must be an absolute path.");
  let result: unknown;
  switch (command) {
    case "plan": result = await planDataMigrationAsync(dataDir); break;
    case "apply": result = await applyDataMigrationAsync(dataDir); break;
    case "rollback": result = await rollbackDataMigrationAsync(dataDir, values.transaction!); break;
    case "recover": result = await recoverDataMigrationAsync(dataDir); break;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
mainAsync().catch((error: unknown) => {
  // Never serialize parsed configuration, task contents, or provider credentials.
  const message = error instanceof DataMigrationError ? error.message
    : error instanceof Error && error.name === "DataLockError" ? error.message
    : `Migration command failed (${(error as NodeJS.ErrnoException)?.code ?? "unexpected error"}). Keep the service stopped and inspect the migration journal.`;
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, status: "failed", error: message,
    ...(error instanceof DataMigrationError && error.transactionId ? { transactionId: error.transactionId } : {}),
  }) + "\n");
  process.exitCode = 1;
});
