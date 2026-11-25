# Persistent data migrations

The first migration converts known scheduled-task formats without changing task
IDs, one-time execution dates, history, or extension fields. It validates the
whole plan before changing a task. Original bytes and permissions are kept for
recovery.

This is the first migration milestone. It does not provide a complete upgrade
command, a published release, a database backup, or a system-service conversion.

## Data layout

The default data directory is `~/.blackdogbot`. An absolute
`BLACKDOGBOT_DATA_DIR` overrides it. Use the same directory in the daemon and
the release supervisor. A CLI `--data-dir` selects data for that command only.
Relative overrides and symlinked data roots or managed files are rejected.
This keeps the backup and restore paths inside one explicit data directory.

| Location under the data directory | Purpose |
| --- | --- |
| `config.yaml` | Read and validate settings. Do not rewrite or copy values into reports. |
| `timed/<taskId>.json` | Convert supported scheduled-task fields. |
| `.data-schema.json` | Record schema version 1 and its `timedTasks` component. |
| `.migrations/lock.json` | Exclude concurrent new daemons and migration commands. |
| `.migrations/recovery.json` | Exclude new lock owners during explicit stale-lock recovery. |
| `.migrations/transactions/<id>/journal.json` | Record the files, before/after checksums, permissions, sequence, and transaction state. |
| `0000.before`, `0000.after`, etc. inside a transaction | Store original and converted file bytes, with private permissions. |

The application version is independent of the data schema. Old installations
have no marker and are inspected by file shape. Version `0.1.0` alone cannot
identify their data format. A newer or unknown schema blocks startup.

Schema version 1 covers scheduled-task files only. Sessions, SQLite databases,
knowledge stores, prompts, skills, MCP registrations, and Docker state keep their
existing formats. This marker does not certify compatibility of future changes
to those stores.

## Inspect and apply

Run these commands from the source checkout with dependencies installed:

```bash
pnpm migrate:plan --data-dir /absolute/path/to/.blackdogbot
```

The plan is read-only. It returns JSON containing paths and reasons, without
configuration values or task contents. It also identifies the timezone used to
fill missing task timezones.

Before applying, stop every process that writes that data directory. For the
standard user service:

```bash
systemctl --user stop blackdogbot.service
pnpm migrate:apply --data-dir /absolute/path/to/.blackdogbot --offline
systemctl --user start blackdogbot.service
```

Only start the service if apply succeeds. `--offline` confirms that old daemons
and other writers have been stopped. New daemons hold the same data lock as the
migration command. Releases made before this lock was introduced do not honor
it. The flag alone cannot stop an old manually launched process.

Apply rebuilds the plan under the lock, validates input checksums, and saves all
originals before the first replacement. Each file is written through a synced
temporary file and atomic rename. The journal is durable before task writes.
The schema marker is written after task files. A pending journal blocks startup.

Repeating a successful apply returns `unchanged`. Importing a supported legacy
task later produces a new transaction even if the schema marker already exists.

Normal daemon startup validates stored tasks before it starts providers,
databases, messaging, or the scheduler. It may record a baseline marker when all
existing tasks already have the current format. It does not silently convert
legacy task files.

## Supported task conversions

The fixtures in `tests/fixtures/migrations/timed` record their historical
source shapes. The supported conversions include:

- Convert whole-minute `intervalMs` into `every.hours` and `every.minutes`.
- Convert `offsetMinutes` into `offsetFromDayStart`.
- Supply missing supported defaults and a validated timezone.
- Keep a one-time task's exact `runAt`. Remove an unused legacy offset instead
  of calculating a new execution time.
- Preserve unknown fields when loading and later saving the task.

Interval schedules use the current day-start grid. Very old releases used a
delay relative to startup. That original phase is not recoverable from the
stored task. The plan names the conversion so it can be reviewed.

Unsupported or ambiguous state stops the whole plan. Examples include
conflicting old/new fields, sub-minute or multi-day intervals, an unknown
schedule type, invalid configuration, unresolved legacy `cron/*.json` files, and a filename
that differs from its task ID. Files are not silently rounded, skipped, renamed,
or deleted.

A fully validated legacy one-time record with stored successful completion is
retained in `cron/`, byte for byte. Its completion time must be at or after its
scheduled time, with no stored error. The preview reports
`preservedLegacyRecords`. It is not imported or scheduled again. This rule uses
stored completion evidence and does not depend on the current clock. Recurring,
pending, failed, malformed, and unknown legacy records still block migration.

## Rollback and interrupted work

A successful apply returns a `transactionId`. Keep the service stopped while
restoring it:

```bash
pnpm migrate:rollback --data-dir /absolute/path/to/.blackdogbot --transaction TRANSACTION_ID --offline
```

Only the latest remaining transaction can be rolled back. Before restoring
anything, the runner checks every original backup and every affected live file.
A live file must match either its recorded original or converted bytes and
permissions. A newer edit blocks rollback. This avoids overwriting task updates
or user changes made after activation.

For an interrupted apply or restore:

```bash
pnpm migrate:recover --data-dir /absolute/path/to/.blackdogbot --offline
```

Recover can reclaim a well-formed lock from a proven-dead process on this host.
It restores an interrupted transaction to its original state. A live process,
foreign host, corrupt lock, corrupt backup, newer file edit, or unfinished
recovery barrier stops automatic recovery. Preserve the files and inspect the
reported condition before changing lock metadata.

Recover does not undo a completed migration. If the transaction is already
`applied`, inspect the plan and either start compatible code or explicitly roll
back its receipt. Do not start old code against a newer schema.

These backups cover only files changed by this migration. They cannot undo
messages already sent or restore unrelated runtime data. See
[guarded application updates](guarded-self-update.md) for activation ordering and
the limits of automatic rollback.

## Verification

```bash
pnpm typecheck
pnpm test:migrations
python3 -m unittest discover -s tests/python -p 'test_guarded_*.py'
```

Tests use temporary data directories and synthetic credentials. They cover
historical task shapes, repeated application, interruption, backup corruption,
newer-edit conflicts, lock recovery, and the release supervisor's activation
order.

## Next milestones

1. Inventory and add explicit conversions for the earlier `cron/` layout and
   unsupported historical schedule types.
2. Add consistent backups and compatibility rules for SQLite, sessions, and
   knowledge stores before changing those schemas.
3. Hold external task/message effects until an upgrade is committed.
4. Add installation discovery for legacy system-wide services and MCP runtimes.
5. Make the complete fast suite independent of installed model caches, then add
   clean-install and upgrade CI before publishing versioned releases.
