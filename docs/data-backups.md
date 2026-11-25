# Persistent-data backups

A snapshot captures the bot's persistent data directory before an upgrade.
Configuration and secrets, sessions, tasks, SQLite files, knowledge data, custom
prompts and skills, uploads, workspace files, and migration history are included.
Unknown directories are included unless explicitly excluded below.

The commands require Linux, Python 3.9 or newer, Node.js 22.13.0 or newer, and installed
repository dependencies. Python supplies the atomic directory publication that
refuses to replace an existing destination. Unsupported hosts fail closed.

## Coverage

| Data | Treatment |
| --- | --- |
| Files under the selected data root | Copy bytes, record modes and SHA-256 hashes. |
| SQLite databases and WAL/SHM sidecars | Copy together while writers are stopped, then validate a disposable copy. |
| Schema marker, migration journals, import ledger | Include for compatibility checks and recovery. |
| Top-level `deploy`, `models`, `cache`, `logs` | Exclude reproducible code/cache files and logs. |
| `.migrations/lock.json`, `.migrations/recovery.json` | Exclude active process ownership metadata. |
| Active knowledge or model-profile stores outside the root | Refuse backup until their coverage is resolved. |
| External configured skill-source directories | List as read-only references. Do not copy them. |
| Symlinks and special files within the included tree | Refuse backup. |

A snapshot is not a backup of the whole host. External MCP runtimes, browser
packages, Docker images, and external volumes need their own recovery procedure.

`knowledge.lancedbPath` must identify its actual absolute location within the
selected data root. The current vector store uses that value literally. A
relative path or `~` shorthand can point elsewhere. The upgrade command can
resolve and copy supported legacy locations through a journaled path migration.
It retains originals and refuses conflicting populated stores. See
[data migrations](data-migrations.md).

## Inspect coverage

```bash
pnpm migrate:plan --data-dir /absolute/path/to/.blackdogbot
```

This read-only command returns `backupProtocolVersion: 1`, `backupReady`, and
either a file inventory summary or a safe `backupIssue`. Counts are a preview.
Creation rechecks the source after shutdown.

## Create and verify

1. Stop every writer, including manually started older bot processes.
2. Choose a new absolute backup path outside the data root.
3. Create the snapshot:

   ```bash
   pnpm backup:create --data-dir /absolute/path/to/.blackdogbot --backup-dir /absolute/backups/before-upgrade --offline
   ```

4. Verify it:

   ```bash
   pnpm backup:verify --backup-dir /absolute/backups/before-upgrade
   ```

`--offline` is an assertion, not a service-stop command. The data lock protects
against cooperating current processes. Source hashes, identities, and directory
contents are rechecked to detect other writers.

Creation writes into a private staging directory and publishes only a complete,
verified snapshot. The final backup path must not already exist. A failed copy,
disk-full condition, changed source, invalid SQLite database, or publication
conflict stops the operation.

The snapshot contains `manifest.json`, `manifest.sha256`, and `payload/`.
The manifest records the source directory, schema marker, file hashes and modes,
SQLite inventory, exclusions, and external skill references. Stored copies have
private permissions. Treat the complete snapshot as sensitive.

Verification reads only the snapshot. It checks the manifest, payload inventory,
hashes, and database integrity. SQLite validation runs on disposable copies so
opening a WAL database cannot change either the source or saved bytes. Hashes
detect accidental changes. They are not a signature against an attacker who can
replace both manifest and payload.

Backups are retained after successful and failed upgrades. Cleanup is explicit,
using the retention command below. Keep enough free disk space for the snapshot
and disposable SQLite validation copies.

## Restore into a new directory

Use the source checkout or retained release that created the snapshot:

```bash
pnpm backup:restore --backup-dir /absolute/backups/before-upgrade --destination /absolute/recovery/restored-data --offline
```

The destination must not exist, including as an empty directory. Restore verifies
the snapshot, stages the files, and publishes the destination without replacing
an existing path. It restores recorded bytes and modes. The receipt identifies
the original `sourceDataDir`.

This is a staging restore. It does not change the service, current release, or
live data directory. Configuration retains its original absolute paths, which
can still refer to the original installation. Inspect those references and choose
code compatible with the restored schema before any live switch. Keep the
current data until the recovered copy is verified.

The guarded updater never restores this whole snapshot automatically after a
failed health check. After activation acceptance, the candidate may have received messages or changed
databases. Automatic recovery restores only unchanged migration-owned files.
The full snapshot remains available for an explicit recovery decision.

See [data migrations](data-migrations.md) for scoped rollback and
[guarded updates](guarded-self-update.md) for activation reports and using backup
tools from a retained candidate after the running code has rolled back.


## Backup retention

Preview cleanup without changing files:

~~~sh
pnpm backup:prune --data-dir /absolute/path/to/.blackdogbot
~~~

Apply the same policy after reviewing the preview:

~~~sh
pnpm backup:prune --data-dir /absolute/path/to/.blackdogbot --apply
~~~

The command verifies each complete snapshot before deciding what can be removed.
It keeps:

- The newest three verified snapshots for this exact data root.
- All snapshots newer than 14 days.
- Backups referenced by the current deployment or unresolved recovery reports.
- Corrupt snapshots, other installations, unknown entries, staging directories,
  and interrupted cleanup evidence.

Use `--keep N` and `--min-age-days DAYS` to change the policy. At least two
verified backups and a one-day minimum age are required. `--backup-root` selects
a nonstandard backup directory. `--state` must identify the actual supervisor
state when it is outside the default `DATA_DIR/deploy`.

The default backup root is a sibling named `DATA_DIR-backups`. The cleanup
operation holds deployment and retention locks, rechecks reports and hashes,
then moves each eligible backup into a private retirement path before deletion.
A report change or verification failure preserves that retired copy and its
receipt. Missing or corrupt guarded deployment reports block cleanup.

Receipts live in `BACKUP_ROOT/.retention-receipts`. Interrupted copies have
`.retiring-` names and are never removed by a later cleanup automatically.
Inspect the receipt and restore or remove that copy explicitly after resolving
the interruption. If the cleanup process died while holding its metadata lock,
`--apply --recover-lock` can reclaim only a confirmed stale lock.

Preview and apply both read every snapshot's bytes. Large backup sets can take
time and need temporary space for SQLite verification. Cleanup does not delete
legacy database sources, import ledgers, or migration journals.
