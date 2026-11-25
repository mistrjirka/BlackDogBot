# Guarded application updates

The release manager prepares a tested Git snapshot, stops the user service,
migrates supported data, and checks the new process. If startup fails, it restores
migration-owned files before it starts the previous code.

This procedure requires a **user-level** `blackdogbot.service`. Older system-wide
services need a separate service migration. Do not rerun `install.sh` to upgrade
an existing installation.

## What is protected

The first data schema covers the format of scheduled-task files under
`~/.blackdogbot/timed`. The migration runner validates configuration, records the
data version in `.data-schema.json`, and saves original file bytes and a journal
under `.migrations/transactions/<transaction-id>`.

Rollback checks every file that the migration changed before restoring any file.
If the candidate or a user edited one of those files afterwards, rollback stops
with a conflict. After a verified stop, the supervisor retains the stopped state and the
candidate startup checks. If stopping itself fails, the report marks
`service_stopped: false` and no data restoration is attempted. It does not silently replace newer edits.

This is **not a backup of all runtime data**. It does not roll back sessions,
SQLite databases, knowledge files, Docker state, or messages already sent.
Scheduled tasks and message handling can run during the startup health check.
Take a separate consistent backup before changes outside the supported schema.

Unknown data versions, invalid tasks, incomplete transactions, and legacy code
that cannot verify a versioned data directory block an automatic start or
downgrade.

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
   Python guarded-updater tests. It does not change the running release.

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

Activation checks the candidate's migration plan while the current bot is still
running. It then stops the service, verifies that its process has exited, points
the stable launcher at the candidate, and applies the migration. Moving the
pointer before migration ensures that an interrupted upgrade starts code that
understands pending transaction checks.

The runner replans under its exclusive data lock after shutdown. It saves all
originals before the first write. Migration errors leave the bot stopped for
recovery.

After migration, the supervisor starts the candidate. Readiness logs must belong
to its current systemd invocation. The same process and invocation must remain
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

After successful recovery, either apply the candidate migration again while
stopped, or activate the previous tested commit from the deployment report.
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
