# Guarded application updates

The release manager prepares a tested Git snapshot, stops the user service,
creates and verifies a persistent-data backup, migrates supported data, and checks
the new process. If startup fails, it restores migration-owned files before it
starts the previous code.

This procedure requires a **user-level** `blackdogbot.service`. Older system-wide
services need a separate service migration. Do not rerun `install.sh` to upgrade
an existing installation.

## What is protected

Every activation that changes the release requires a verified backup of the
runtime data directory. The snapshot includes configuration and secrets,
sessions, scheduled tasks, databases and their required on-disk state, knowledge,
custom skills and prompts, other user files, and migration history.

The backup excludes only the top-level `deploy`, `models`, `cache`, and `logs`
directories plus the active `.migrations/lock.json` and
`.migrations/recovery.json` files. It records its source directory, file inventory,
and content hashes. Included symlinks and special files are rejected. Configured
active database or model-profile paths outside the runtime root need separate
handling and block this automatic backup path. External skill-source directories
are read-only inputs and are listed as references rather than copied. See
[persistent-data backups](data-backups.md) for coverage and runtime requirements.

Backups must be outside the runtime directory. By default they are created in
a sibling directory, such as `~/.blackdogbot-backups`, with a unique name for each
activation. `--backup-root /absolute/backup/location` selects another parent
directory. Snapshots are retained after success and failure. There is no automatic
retention cleanup yet.

The guard verifies the snapshot and saves its path and manifest hash in a durable
`backup_ready` deployment report before changing the release pointer or data.
Every later outcome retains this backup receipt. Backup failure leaves the
service stopped with the previous release selected and no migration applied.

### Automatic rollback has a narrower scope

Scheduled-task migrations record their originals under
`.migrations/transactions/<transaction-id>`. Automatic rollback checks every
file that the migration changed before restoring any file. If the candidate or
a user edited one of those files afterwards, rollback stops with a conflict.

After a verified stop, the supervisor retains the stopped state and the candidate
startup checks. If stopping itself fails, the report marks
`service_stopped: false` and no data restoration is attempted.

The full persistent-data snapshot is retained for **explicit recovery**. The
supervisor does not restore the whole directory automatically after a failed
health check. This avoids discarding new sessions, messages, or database writes.
Scheduled tasks and message handling can run during the health check. A snapshot
cannot undo messages or other external effects that already happened.

Unknown data versions, invalid tasks, incomplete transactions, and legacy code
that cannot verify a versioned data directory block an automatic start or
downgrade. A candidate without backup protocol support is rejected before the
service stops. Automatic rollback may still use an older tested release when the
restored data is compatible.

## Install or refresh the independent supervisor

Run these commands from the reviewed source checkout:

```bash
install -D -m 700 scripts/guarded-release.py "$HOME/.local/lib/blackdogbot/guarded-release.py"
install -D -m 700 scripts/guarded-container-update.py "$HOME/.local/lib/blackdogbot/guarded-container-update.py"
```

These copies run outside the daemon and survive application updates. Editing the
source scripts does not refresh the installed copies.

The source checkout is discovered from `--repo`, `BLACKDOGBOT_SOURCE_DIR`, the
script location, the current working directory, the last successfully prepared
source location, or the fresh install location
`~/.local/share/blackdogbot/source`. Supply `--repo` when there is ambiguity.

## Prepare and activate an update

1. Commit the candidate in the source checkout.
2. Prepare its full commit ID:

   ```bash
   python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" prepare \
     --repo /path/to/BlackDogBot --revision <candidate-full-sha>
   ```

   Preparation creates a detached release worktree. It runs dependency
   installation with the frozen lockfile, TypeScript, the fast test suite, and
   Python installer, MCP, and guarded-updater tests. It does not change the running release.

3. Inspect the preparation log and release marker under
   `~/.blackdogbot/deploy`.
4. Activate the tested commit:

   ```bash
   python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" activate \
     --revision <candidate-full-sha> --skip-container-updates
   ```

   When the bot itself starts this command, run the external supervisor through
   a detached `systemd-run --user` unit so stopping the bot cannot stop its
   updater. Supply `--chat-id` only for the intended status recipient.

5. Inspect `~/.blackdogbot/deploy/reports/latest.json` and the user service.

Importing supported legacy task files is explicit. Add
`--import-legacy-tasks` to the activation command only after reviewing its
migration plan. The flag is forwarded to planning and application, and the
snapshot preserves the original legacy files before import.

Activation checks the candidate's migration plan while the current bot is still
running. It checks backup support and source eligibility, then stops the service
and verifies that its process has exited. It creates and verifies the snapshot
and records its receipt. Only then does it point the stable launcher at the
candidate and apply the migration. Moving the pointer before migration ensures
that an interrupted upgrade starts code that understands pending transaction
checks.

The runner replans under its exclusive data lock after shutdown. It saves all
originals before the first write. Migration errors leave the bot stopped for
recovery.

After migration, the supervisor starts the candidate. Startup readiness records
must belong to its current systemd invocation. The same process and invocation must remain
healthy for six seconds. Telegram polling readiness is required only when
Telegram is configured. Discord-only and no-messaging configurations are
supported.

If health fails, the supervisor stops the candidate, restores its migration
transaction, checks that the previous release can read the resulting schema,
and restarts that release. A restore conflict prevents the old code from
starting. Reports include the transaction ID.

Omitting `--skip-container-updates` retains the existing behavior of checking
enabled Docker services after application health. Container updates have their
own validation and rollback. They are not part of the data migration transaction.

`--data-dir` selects the data directory passed to the migration runner. Its default
honors `BLACKDOGBOT_DATA_DIR`, otherwise it is `~/.blackdogbot`. The guard verifies
that it matches the daemon's environment before stopping or migrating. A stopped
service with `EnvironmentFiles` requires a running-process check because its
effective data root cannot be safely inferred. The flag does not configure the
systemd service. Symlink data roots are rejected.

## Bootstrap a guarded launcher

For a user service that still runs directly from a checkout:

1. Prepare the current known-good commit.
2. Verify that its migration plan needs no changes. If task conversion is
   required, stop the service and use the migration CLI before bootstrap.
3. Run:

   ```bash
   python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" bootstrap \
     --repo /path/to/BlackDogBot --revision <known-good-full-sha>
   ```

4. Confirm `bootstrap_healthy` in the latest report.

Bootstrap refuses a release whose data still needs migration. It installs an
external launcher and a user systemd drop-in. If the service does not start, it
restores the original unit configuration. It does not convert system-wide units.

## Inspect or restore a full snapshot

Use the backup path from a deployment report and the tested candidate that
created it. That release is retained even if the live bot rolled back to older
code without backup commands:

```bash
snapshot_tool="$HOME/.blackdogbot/deploy/releases/<candidate-full-sha>"
"$snapshot_tool/node_modules/.bin/tsx" "$snapshot_tool/src/migrations/cli.ts" backup-verify \
  --backup-dir /absolute/path/from/report
```

Verification needs only the snapshot. It does not read or modify the live data
directory. To restore into a new staging directory:

```bash
"$snapshot_tool/node_modules/.bin/tsx" "$snapshot_tool/src/migrations/cli.ts" backup-restore \
  --backup-dir /absolute/path/from/report \
  --destination /absolute/path/that/does/not/exist --offline
```

The destination must not exist. Restoration does not overwrite a live
installation or change its service or release pointer. The result identifies
the original `sourceDataDir`.

**Treat this as a staging restore.** Configuration retains its original absolute
paths. Inspect configuration and all referenced directories before using the
restored copy. Choose code that supports the restored schema before switching
any live paths. Keep the current data until recovery has been verified.

## Recover an interrupted migration

Keep the service stopped until recovery completes:

```bash
systemctl --user stop blackdogbot.service
candidate="$HOME/.blackdogbot/deploy/current"
"$candidate/node_modules/.bin/tsx" "$candidate/src/migrations/cli.ts" recover \
  --data-dir "$HOME/.blackdogbot" --offline
```

Recovery rolls back incomplete published transactions. It refuses a live data
lock or files that no longer match the transaction's recorded contents. If it
reports a conflict, preserve the journal and both file versions and resolve the
difference before restarting.

After successful recovery, apply the candidate migration again while stopped,
or select a compatible tested release that supports verified backups. The new
supervisor rejects a fresh activation of pre-backup code. Returning to such code
after an interrupted operation requires an explicit manual recovery decision
with verified compatible data. Immediate automatic rollback after a failed
activation remains supported.
An explicit rollback of a completed migration uses:

```bash
"$candidate/node_modules/.bin/tsx" "$candidate/src/migrations/cli.ts" rollback \
  --data-dir "$HOME/.blackdogbot" --transaction <transaction-id> --offline
```

The migration CLI manages data only. It does not stop services, change release
pointers, or undo external effects. Do not run mutating commands against an
active legacy process that does not participate in the data lock.

Reports and backups are private files. They can contain runtime data and
credentials. Do not publish them.
