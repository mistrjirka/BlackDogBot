# Guarded application updates

The supervisor tests a candidate, stops the current service, preserves runtime
data, and starts the candidate with external work paused. It validates that exact
process before accepting it. Telegram updates, Discord events, scheduled tasks,
agent calls, skill installation, MCP processes, outgoing messages, and Brain
commands stay paused until acceptance is durable.

For an existing installation, use the [upgrade entry point](upgrade.md).
It discovers the actual service and data directory, refreshes the independent
supervisor from tested code, and handles direct-checkout and system-service
conversion. Do not rerun the fresh installer to upgrade existing data.

This document describes the lower-level supervisor. Its service operations use
a **user-level** systemd unit. Converting an older system-wide unit is a separate,
recorded step in the upgrade entry point.

## Activation sequence

| Step | What changes | Can external work run? |
| --- | --- | --- |
| Prepare | Create an isolated release, install frozen dependencies, run checks | Only the old service |
| Plan | Discover the old process directory, inspect data and backup coverage | Only the old service |
| Stop | Confirm the old service has no process | No |
| Relocate, if required | Copy and verify a legacy knowledge database, record configuration changes | No |
| Snapshot and migrate | Verify a full backup, record its receipt, migrate task files | No |
| Validate candidate | Initialize local services, bind the Brain port, authenticate messaging, write readiness | No |
| Accept | Sync approval, then publish a separate release signal | Candidate work may begin |
| Verify active startup | Require daemon and configured messaging readiness for the current invocation | Yes |

Database relocation runs before the full snapshot so the snapshot includes the
active database. A separate path transaction preserves its original inventory
and configuration. The guard does not bypass unrelated backup coverage errors
because a path migration is available.

Before path or task changes, the launcher selects code that understands their
startup barriers. A crash during these changes cannot silently restart an older
release that ignores the new journal. If no path relocation is needed, the
release pointer changes only after the verified snapshot is recorded.

## What is protected

Each activation that changes the release requires a verified snapshot of the
runtime data directory. It covers configuration and secrets, sessions, scheduled
tasks, databases and their required on-disk state, knowledge, custom skills and
prompts, other user files, and migration history.

The snapshot excludes the top-level `deploy`, `models`, `cache`, and `logs`
directories, plus the active `.migrations/lock.json` and
`.migrations/recovery.json` files. It records its source directory, inventory,
and content hashes. Included symlinks and special files are rejected. Active
database or model-profile paths outside the runtime root block backup until
covered. External skill-source directories are read-only references.
See [persistent-data backups](data-backups.md) for the complete coverage rules.

Backups live outside the runtime directory. The default is a sibling such as
`~/.blackdogbot-backups`, with a unique snapshot name per activation.
`--backup-root /absolute/location` selects another parent directory. The guard
retains snapshots after success and failure. The separate
[retention command](data-backups.md#backup-retention) previews or applies cleanup
and protects recent snapshots and unresolved recovery receipts.

A durable `backup_ready` report records the verified snapshot path and manifest
hash before task migration. Later outcomes retain that receipt. If the snapshot
fails after a completed database relocation, the guard attempts the recorded
path rollback. It keeps the service stopped. A path rollback conflict preserves
the candidate selection and requires explicit recovery.

## Readiness and durable acceptance

Activation metadata always lives under the selected data root:

- `deploy/activation.json`: candidate path, revision, random nonce, pending or
  committed state, and accepted process identity.
- `deploy/activation-ready.json`: readiness for that nonce and the current
  systemd invocation.
- `deploy/activation-release.json`: permission to begin external work, written
  only after the committed approval and its directory have been synced.
- `deploy/activations/<nonce>/context.json`: previous approval, previous code,
  task and path transaction receipts, and snapshot receipt.

These files are outside snapshot payloads. Restoring data into a staging
directory cannot resurrect an old process approval.

During pending validation, the daemon checks recovery barriers before opening
runtime data. It initializes configuration, providers, local storage and the
actual Brain listening port. Brain connections are rejected with a retryable
startup error. Telegram validation calls only `getMe` and `getWebhookInfo`.
It never calls `getUpdates`, advances an update offset, or deletes a webhook.
Discord validation uses a read-only identity request and does not connect its
gateway. Discord has the usual offline-service downtime during this stage.

Skills, dependency checks, auto-setup, MCP connections, outbox workers, messaging
adapters, scheduler execution, and Brain command handlers start after release.
A connection cannot be accepted early and have its command silently discarded.

The supervisor requires a stable readiness receipt from the current systemd
invocation for six seconds. It checks the actual runtime process, including a
Node child of the service's main process. It commits acceptance, syncs it, then
writes the separate release signal. Active startup must subsequently report
daemon readiness and Telegram readiness or disabled state for the same live
invocation. Readiness does not depend on the configured log level.

A prepared release under `releases/<full-sha>` refuses startup without matching
approval. Candidates must advertise `activationProtocolVersion: 1` and
`backupProtocolVersion: 1`. An older supervisor cannot start a new prepared
release while accidentally bypassing this protocol. Normal direct source
starts with no pending activation and healthy restarts of an accepted release
continue to work.

## Failure and rollback

**Before acceptance**, the candidate has not consumed messages or started
external work. The guard stops it, rolls back task changes, rolls back database
path changes, checks the previous code's data compatibility, restores its
approval, and restarts it. Each rollback checks that current contents match the
recorded transaction. A conflict leaves the service stopped with both versions
and receipts preserved.

**After commitment**, external work may already have started. A failed startup
check produces `activation_committed_unhealthy` and stops the service. The guard
retains the selected candidate, current data, and all receipts. It does not
automatically select older code or restore data over possible new work.

The full snapshot is always for explicit recovery. Even a complete snapshot
cannot undo a message or another external effect. Unknown schemas, incomplete
transactions, malformed approvals, incompatible candidates, or an unverified
service stop block automatic restoration. A failed stop records
`service_stopped: false`.

## Prepare and activate with the lower-level supervisor

Run from the reviewed source checkout:

~~~bash
install -D -m 700 scripts/guarded-release.py "$HOME/.local/lib/blackdogbot/guarded-release.py"
install -D -m 700 scripts/guarded-container-update.py "$HOME/.local/lib/blackdogbot/guarded-container-update.py"
~~~

These independent copies survive daemon updates. Editing a source script alone
does not refresh its installed copy. The upgrade entry point refreshes them
from its tested candidate.

Prepare a committed revision:

~~~bash
python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" prepare \
  --repo /path/to/BlackDogBot --revision <candidate-full-sha>
~~~

Preparation creates a detached worktree and runs frozen dependency installation,
TypeScript, fast tests, and Python deployment tests. It does not switch the
running release. Inspect its log and passing marker under the selected state
directory before activation:

~~~bash
python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" activate \
  --revision <candidate-full-sha> --skip-container-updates
~~~

When the bot launches its own upgrade, run the supervisor in a detached
`systemd-run --user` unit so stopping the bot cannot stop its updater.
Notifications are disabled unless `--chat-id` explicitly names the intended
recipient. Known chat files are never used to choose a status recipient.

Useful options:

| Option | Meaning |
| --- | --- |
| `--data-dir /absolute/path` | Runtime data root. Must match the service environment. Defaults to `BLACKDOGBOT_DATA_DIR`, otherwise `~/.blackdogbot`. |
| `--state /absolute/path` | Supervisor releases, current pointer and reports. Approval still lives in `DATA_DIR/deploy`. |
| `--runtime-cwd /absolute/path` | Actual previous process directory for resolving a legacy relative database path. |
| `--database-source /absolute/path` | Explicit reviewed legacy database source when discovery is ambiguous. |
| `--import-legacy-tasks` | Explicitly import supported legacy task directories during planning and application. |
| `--skip-container-updates` | Deploy the bot without separately updating enabled Docker services. |
| `--timeout SECONDS` | Time budget for each validation and active-health phase. |

The supervisor discovers the current process directory before stopping it.
It verifies the actual data directory from the process environment. A stopped
service with `EnvironmentFiles` needs a verified running-process check.
Changing `--data-dir` does not change the unit's configuration.

The source checkout is discovered from `--repo`, `BLACKDOGBOT_SOURCE_DIR`, the
script or current directory, the saved preparation source, or the fresh install
source at `~/.local/share/blackdogbot/source`.

## Resume an interrupted activation

If the approval is pending and the candidate is already selected, repeat
`activate` with the same full revision, state directory and unit. The guard uses
the original snapshot and transaction receipts. It revalidates the live
invocation or restarts the stopped candidate. It does not reapply migrations
or report success while the gate is closed.

A crash after durable commitment but before the release signal also leaves work
paused. Repeating activation revalidates the current candidate before releasing
it. An already accepted but stopped candidate requires inspection and an
explicit restart. A different pending revision, missing recovery context or
damaged approval requires recovery before another activation.

Do not delete or edit approval files to force startup.

## Bootstrap a fresh guarded user launcher

The `bootstrap` command is for a tested candidate whose task and database-path
plans already need no changes. Existing direct-checkout and system services
should use the upgrade entry point, which preserves their original runtime
directory and pinned rollback code.

~~~bash
python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" bootstrap \
  --repo /path/to/BlackDogBot --revision <candidate-full-sha>
~~~

Bootstrap takes a verified snapshot, installs the external launcher and user
drop-in, and uses the same pending, committed and released protocol. A failure
before acceptance restores the original unit. A failure after commitment keeps
the candidate stopped for explicit recovery.

## Recover data transactions

Keep the service stopped. Use the retained candidate that owns the transaction:

~~~bash
systemctl --user stop blackdogbot.service
candidate="$HOME/.blackdogbot/deploy/current"
"$candidate/node_modules/.bin/tsx" "$candidate/src/migrations/cli.ts" recover \
  --data-dir "$HOME/.blackdogbot" --offline
~~~

Recovery rolls back incomplete published task transactions. To undo a completed
task transaction, use its receipt:

~~~bash
"$candidate/node_modules/.bin/tsx" "$candidate/src/migrations/cli.ts" rollback \
  --data-dir "$HOME/.blackdogbot" --transaction <task-transaction-id> --offline
~~~

Recover incomplete path changes with `paths-recover`. Undo a completed path
transaction with `paths-rollback --transaction <path-transaction-id>`.
Restore task changes before path changes. Both commands require `--offline`
and the correct `--data-dir`. A conflict means current bytes differ from the
receipt. Preserve both versions and resolve it before restarting.

These commands change data only. They do not stop services, alter approvals,
switch releases, or undo external effects. Old code that does not participate
in the data lock must remain stopped throughout recovery.

## Verify or restore a full snapshot

Use the snapshot path from the deployment report and the tested release that
created it:

~~~bash
snapshot_tool="$HOME/.blackdogbot/deploy/releases/<candidate-full-sha>"
"$snapshot_tool/node_modules/.bin/tsx" "$snapshot_tool/src/migrations/cli.ts" backup-verify \
  --backup-dir /absolute/path/from/report
~~~

Verification reads only the snapshot. Restore into a new staging directory:

~~~bash
"$snapshot_tool/node_modules/.bin/tsx" "$snapshot_tool/src/migrations/cli.ts" backup-restore \
  --backup-dir /absolute/path/from/report \
  --destination /absolute/path/that/does/not/exist --offline
~~~

The destination must not exist. This does not overwrite live data or switch its
service. Configuration retains original absolute paths. Review them and choose
code compatible with the restored schema before using the staging copy.
Keep current data until recovery has been verified.

Reports and snapshots are private and can contain credentials. Do not publish
them.
