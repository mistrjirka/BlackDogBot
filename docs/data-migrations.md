# Persistent data migrations

Migrations convert supported scheduled-task files and keep the original bytes and
permissions for recovery. The runner validates the whole plan before changing a
file. Application versions and stored-data versions are independent.

## Data layout

The default data directory is `~/.blackdogbot`. An absolute
`BLACKDOGBOT_DATA_DIR` overrides it. Use the same directory in the daemon and the
release supervisor. CLI `--data-dir` selects data for that command only. Relative
overrides and symlinked data roots or managed files are rejected.

| Location under the data directory | Purpose |
| --- | --- |
| `config.yaml` | Validate settings without rewriting them or exposing credentials in reports. |
| `timed/<taskId>.json` | Current scheduled-task files. |
| `cron/<taskId>.json` | Original legacy records, retained unchanged after import. |
| `.data-schema.json` | Schema 2, with `timedTasks: 1` and `legacyCronImports: 1`. |
| `.migrations/legacy-imports.json` | Required schema 2 ledger of imported sources, checksums, IDs, and targets. |
| `.migrations/lock.json` | Exclude concurrent new daemons and migration commands. |
| `.migrations/recovery.json` | Exclude new lock owners during explicit stale-lock recovery. |
| `.migrations/transactions/<id>/journal.json` | Before/after checksums, permissions, order, and transaction state. |
| `.migrations/retired-transactions/<id>/` | Completed rollback evidence kept outside the journal scan used by older code. |
| `0000.before`, `0000.after`, etc. inside a transaction | Original and converted bytes, stored privately. |

Unversioned data is inspected by file shape. Schema 1 can upgrade to schema 2.
Newer or unknown schemas block startup. Version `0.1.0` alone does not identify
an installation's stored format.

Schema 2 covers scheduled tasks and legacy-import tracking. Sessions, SQLite
databases, knowledge stores, prompts, skills, MCP registrations, and Docker state
retain their current formats. The schema marker does not certify future changes
to those stores. [Persistent-data backups](data-backups.md) protect their current
on-disk bytes before an upgrade.

## Database path repair

Fresh configurations use an absolute LanceDB path under the selected data
directory: `DATA/knowledge/lancedb`. Existing configurations are not silently
relocated at startup. An enabled knowledge provider with a relative or omitted
stored path must complete the explicit repair first.

Some older configurations stored `~/.blackdogbot/knowledge/lancedb` or
`~/.betterclaw/knowledge/lancedb`. The old runtime passed these strings to the
database without expanding `~`. The resulting directory could therefore be
inside the running release's working directory. A home-expanded legacy directory
can also contain the intended data. These are different candidates.

Inspect both locations using the **previous process's actual working directory**:

```bash
pnpm exec tsx src/migrations/cli.ts paths-plan \
  --data-dir /absolute/data \
  --runtime-cwd /absolute/previous-release
```

The plan reads config and candidate filesystem inventories. It does not open
databases or create directories. It reports paths, file counts, byte counts, and
checksums. It never reports config values or stored records. For an omitted path,
it uses the historical default for discovery, not the new absolute default.

If populated stores differ, the command fails and returns
`databasePathCandidates`. Review those paths and repeat with
`--source /absolute/chosen/database`. Explicit selection does not merge stores
or replace a different populated destination. Symlinks, unsupported file types,
overlapping sources, and unclear directory ownership require manual inspection.

For standalone repair:

1. Stop every writer, including old services that do not honor the lock.
2. Apply the chosen path plan with the same source/cwd arguments:

   ```bash
   pnpm exec tsx src/migrations/cli.ts paths-apply \
     --data-dir /absolute/data \
     --runtime-cwd /absolute/previous-release \
     --offline
   ```

3. Create and verify the [full backup](data-backups.md).
4. Apply any required scheduled-task migrations.
5. Start compatible code.

This ordering is an explicit exception for databases that the original full
backup cannot cover. The path repair first retains the original config bytes
privately, leaves the source untouched, copies into a private staging directory,
verifies every copied file, and opens only that private copy for LanceDB schema
and streamed record checks. It publishes the database without overwriting a target,
then changes only the stored database path. An existing empty target is retained
inside the transaction. The config's other values and existing file permissions
survive.

Unified `plan` reports `pathMigrationProtocolVersion: 1`,
`databasePathMigration`, and `preBackupMigrationReady`. The last field is
true only when this exact path repair would resolve all backup blockers.
External mutable profile stores and included symlinks still block activation.
The guarded updater repairs the path offline, replans, and requires
`backupReady: true` before taking the full snapshot. Path moves do not change
database bytes or scheduled-task schema 2.

Path receipts live under `.migrations/database-paths/<transactionId>/`.
Keep them with the original external store. For an interrupted operation:

```bash
pnpm exec tsx src/migrations/cli.ts paths-recover --data-dir /absolute/data --offline
```

Pending path journals block startup before providers or external effects. A
completed repair can be reversed explicitly:

```bash
pnpm exec tsx src/migrations/cli.ts paths-rollback \
  --data-dir /absolute/data --transaction p-TRANSACTION_ID --offline
```

Rollback verifies the original source, config, and migrated database. New rows,
new files, changed permissions, or later config edits prevent automatic rollback.
An unchanged copied database moves into the journal's `retained-data`
directory. It is not deleted. The original config and any original empty target
are restored. Recovery and repeated rollback preserve these retained copies.

## Inspect and apply

Run from the source checkout with dependencies installed:

```bash
pnpm migrate:plan --data-dir /absolute/path/to/.blackdogbot
```

The plan is read-only. It returns JSON with file paths, conversion reasons,
timezone, task counts, and backup eligibility. It omits configuration values and
task contents. `backupReady: false` names a coverage or filesystem problem that
must be resolved before guarded activation.

For a manual migration:

1. Stop every process that writes the selected directory.
2. Create and verify a [full snapshot](data-backups.md).
3. Apply the reviewed plan:

   ```bash
   pnpm migrate:apply --data-dir /absolute/path/to/.blackdogbot --offline
   ```

4. Start compatible code only after apply succeeds.

`--offline` confirms that writers are stopped. It does not stop them. New daemons
share the migration lock. Older releases do not honor it.

Apply rebuilds the plan under the lock and saves originals before the first
replacement. It rechecks input bytes and directory contents before writing.
Each replacement uses a synced temporary file and atomic rename. The journal is
durable before task writes. The ledger follows task writes, and the schema marker
is last. Pending journals block startup.

Repeating a successful apply returns `unchanged`. Importing an additional
supported legacy task creates a new transaction even on schema 2.

Normal startup validates data before providers, databases, messaging, or the
scheduler start. It may create a baseline marker and empty ledger when no task
conversion is needed. It does not import or convert legacy tasks automatically.

## Supported task conversions

Historical fixtures under `tests/fixtures/migrations` identify their source
commits. Supported conversions include:

- Whole-minute `intervalMs` -> `every.hours` and `every.minutes`.
- `offsetMinutes` -> `offsetFromDayStart`.
- Missing supported defaults and a validated timezone.
- One-time tasks retain their exact `runAt`, even if an unused offset was stored.
- IDs, history, enabled state, instructions, tools, and unknown fields survive.

Interval schedules use the current day-start grid. Some early releases used a
delay from startup. Their original phase cannot be recovered from the stored
record. The plan names this conversion.

Conflicting fields, sub-minute or multi-day intervals, unknown schedule types,
invalid configuration, and filename/ID mismatches stop the whole plan. Data is
not silently rounded, skipped, renamed, or deleted.

## Explicit legacy imports

Unresolved `cron/*.json` records block migration by default. To inspect supported
one-time and interval imports:

```bash
pnpm migrate:plan --data-dir /absolute/path/to/.blackdogbot --import-legacy-tasks
```

Review the plan, stop all writers, and take a full snapshot. Apply with the same
flag:

```bash
pnpm migrate:apply --data-dir /absolute/path/to/.blackdogbot --import-legacy-tasks --offline
```

The importer writes a new `timed/<taskId>.json` and records the source hash in the
ledger. It retains the original `cron/` file byte for byte. Existing target files,
duplicate identities, and unsupported cron-expression or `scheduled` formats
block import.

The ledger prevents a deleted imported task from returning on the next startup
or apply. Keep the ledger, its original source files, and migration journals.
Missing or changed sources and missing, corrupt, or inconsistent ledger evidence
block startup. Restoring a matching verified backup is safer than rebuilding
tracking metadata.

A fully validated legacy one-time record with stored successful completion stays
in `cron/` and is never scheduled again. Its completion time must be at or after
its scheduled time, with no stored error. This decision uses stored evidence,
not the current clock. The plan reports `preservedLegacyRecords`,
`legacyTasksToImport`, and `recordedLegacyImports`.

## Rollback and interrupted work

A successful apply returns a `transactionId`. Keep all writers stopped:

```bash
pnpm migrate:rollback --data-dir /absolute/path/to/.blackdogbot --transaction TRANSACTION_ID --offline
```

Only the latest remaining transaction can be rolled back. The runner checks all
original backups and affected live files before restoring anything. A live file
must match its recorded original or converted bytes and permissions. Newer edits
block rollback. Imported files are removed only if unchanged. Original legacy
sources remain intact.

When rollback restores schema 1 or unversioned data, completed schema 2 receipts
move to `.migrations/retired-transactions/`. Their journals and backups remain
intact. Older migration code can then inspect the restored data without rejecting
a future-schema receipt. Interrupted retirement blocks current startup until
recovery finishes. Repeated rollback still recognizes the retained receipt.

For interrupted apply or restore:

```bash
pnpm migrate:recover --data-dir /absolute/path/to/.blackdogbot --offline
```

Recover can reclaim a well-formed lock from a proven-dead process on this host.
It restores an incomplete transaction. Live processes, foreign hosts, corrupt
locks/backups, newer edits, or an unfinished recovery barrier require inspection.

Recover does not undo a completed migration. If a transaction is already
`applied`, either start compatible code or roll back its receipt explicitly.
Do not start old code against a newer schema.

Transaction backups cover only files changed by that migration. A full snapshot
is separate. Neither can undo messages or other external effects. See
[guarded application updates](guarded-self-update.md) for stop, backup, migration,
health-check, and rollback ordering.

## Verification and compatibility limits

```bash
pnpm typecheck
pnpm test:migrations
pnpm test:python
```

Tests cover historical shapes, schema 1 upgrades, explicit import, deleted-task
tracking, repeated apply, interruptions, backup corruption, newer edits, and
lock recovery.

Unknown historical schedule types still stop for explicit review. A future change
to database record structure must add its own versioned data migration. The path
migration copies existing compatible database bytes and does not rewrite records.

Supported older services use the [upgrade command](upgrade.md). External work
waits for durable activation acceptance. Version tags pass the complete CI
matrix before [release assets](releases.md) are published.
