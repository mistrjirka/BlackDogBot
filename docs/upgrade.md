# Upgrade an existing installation

Use `upgrade.py` for an existing bot. `install.sh` remains a fresh-install command and does not replace an existing configuration.

## Normal upgrade

Run commands as the account that owns the bot and its data. Python 3.9 or newer, Node.js 22.13.0 or newer, the release's exact pnpm version, Git, and a working systemd user manager are required. The upgrader checks these before stopping the bot.

From a current source checkout:

```sh
pnpm upgrade:bot -- plan --revision v0.2.0
pnpm upgrade:bot -- apply --revision v0.2.0
```

A version tag is resolved to a full commit before preparation. A full 40-character commit SHA is also accepted. Branch names such as `main` are rejected. Without `--revision`, the upgrader selects the latest published stable GitHub release. If that lookup fails, provide an explicit reviewed tag or SHA. A nonstandard Git origin always requires an explicit revision.

`plan` inspects the installation and resolves the revision. It does not fetch a worktree, install dependencies, write upgrade state, edit configuration, or change service state. It prints the selected source, commit, service, account, data directory, and actual runtime directory. Environment variable names are shown. Their values remain private.

To select an installation explicitly:

```sh
python3 scripts/upgrade.py plan \
  --repo /absolute/path/to/BlackDogBot \
  --scope user --unit blackdogbot.service \
  --data-dir /home/YOUR_USER/.blackdogbot \
  --revision v0.2.0
```

Use the same options with `apply`. If automatic discovery finds more than one service or data directory, it stops and requests these specific options.

## Start from an older checkout

Older versions do not contain this command. Download the standalone script from a reviewed release. It requires only Python's standard library before it prepares the release:

```sh
mkdir -m 700 blackdogbot-upgrade-v0.2.0
cd blackdogbot-upgrade-v0.2.0
curl --fail --location --output blackdogbot-upgrade.py \
  https://github.com/mistrjirka/BlackDogBot/releases/download/v0.2.0/blackdogbot-upgrade.py
curl --fail --location --output SHA256SUMS \
  https://github.com/mistrjirka/BlackDogBot/releases/download/v0.2.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
python3 blackdogbot-upgrade.py plan --repo /absolute/path/to/BlackDogBot --revision v0.2.0
python3 blackdogbot-upgrade.py apply --repo /absolute/path/to/BlackDogBot --revision v0.2.0
```

Use a Git checkout as `--repo`. GitHub's automatic source archives do not contain the Git metadata that the upgrade process needs. The script leaves that checkout on its existing branch and creates separate detached worktrees for prepared releases.

## What application changes

1. Resolve the selected tag or SHA against the checkout's origin.
2. Prepare a separate candidate worktree and install frozen dependencies.
3. Run type checking, the fast test suite, Python tests, and the build.
4. Preserve the installed upgrade supervisor in a private journal, then replace it atomically with the tested copy.
5. Inspect migrations and backup coverage while the current bot still runs.
6. Stop the bot and verify that its process has exited.
7. Correct any supported legacy database path, create and verify the data backup, and apply data migrations.
8. Start the candidate with external processing held. Accept it only after the guarded startup checks pass.

Optional containers are not updated by this application upgrade. Configuration is preserved. A supported database-path migration can change the configured database path to an absolute path. Its transaction keeps the original configuration and database for recovery.

An unchanged, tested revision is reused. A repeated upgrade to the active revision checks its activation receipt and health. It does not silently approve a release with an incomplete activation.

## Older service layouts

| Existing layout | Upgrade behavior |
| --- | --- |
| Guarded user service | Reuse its service and release pointer. Refresh the independent supervisor from the tested candidate. |
| Direct-checkout user service | Freeze the previous clean checkout as a fallback. Add a dedicated service override and a stable launcher. Preserve the original service file. |
| System service running as the data owner | Prepare and test first. Print one explicit administrator command to stop, disable, and mask the old system service. Then create the user service and activate the candidate. |
| System service running as root, or an unsupported custom unit | Stop with an explanation. Do not change ownership, invent a service, or rewrite the custom unit. |

A normal system service file is owned by root. That is expected. The supported system-service case is determined by `User=` and the running process owner. The application and data must belong to that non-root account.

Direct-checkout conversion requires clean tracked source. The fallback records its source revision and original runtime working directory. This matters when an old configuration uses a relative path or a literal `~` directory. The previous code runs from the preserved worktree while retaining the original working directory. The original checkout is left intact. Recovery refuses to restart that original checkout if it has changed since preparation.

The process inspection follows the actual bot Node process below a pnpm or shell parent. It requires a single matching process with the same owner and control group. An ambiguous process tree blocks the upgrade.

### System-service handoff

Run the normal `apply` command as the service account. When administrative access is needed, the result has status `administrator_required` and includes:

- `administratorCommand`: the exact narrow command to execute as an administrator.
- `nextCommand`: the exact unprivileged command to resume the prepared upgrade.
- `journal`: the private upgrade record.

The administrator command verifies the reviewed unit fingerprint before changing it. It preserves the original unit and drop-ins, stops the complete service, disables its boot link, and masks it. For a service that previously started at boot, it enables user lingering if required so the replacement user service can also start at boot. It records the previous lingering state.

The normal upgrader never executes `sudo`, asks for a hidden password, or changes root-owned data. An administrator must explicitly run the printed command. The full upgrade command must not run as root.

The old system unit must remain masked before the replacement can start. An active or enabled competing bot unit blocks the upgrade. Custom service hooks, environment files, privileged identities, nonstandard groups, and unsupported system-unit settings need a separate reviewed conversion.

## Database selection

Normally, the upgrader discovers the old database from the actual runtime directory and configuration. If multiple populated databases make that ambiguous, inspect the choices and select the intended source explicitly:

```sh
python3 scripts/upgrade.py apply \
  --state /absolute/data/directory/deploy \
  --database-source /absolute/path/to/the/existing/lancedb
```

A new source choice is accepted only before data migration starts. `--runtime-cwd` can supply a verified directory for a stopped service. For a running service, it must match the actual bot process directory. Paths must be absolute.

`--import-legacy-tasks` explicitly authorizes importing supported old tasks. The default plan still refuses unresolved or ambiguous legacy data. Review the migration report before using that option.

## Resume or recover

Every apply operation has a private journal under `DATA/deploy/upgrades/u-.../`. The result prints its exact path and recovery command. Logs and original file copies can contain private settings. Keep them private.

After an interrupted preparation or activation, repeat the same command. The saved revision stays pinned. To select the saved operation directly:

```sh
python3 scripts/upgrade.py apply --state /absolute/data/directory/deploy
```

The upgrader reuses verified candidate work, completes interrupted atomic file updates, and asks the guard to resume a pending activation. It refuses to overwrite files that another edit changed after preparation. An interrupted administrator step can be repeated using the same printed administrator command.

If the candidate failed before acceptance and the guard restored compatible data, recover the previous service layout with:

```sh
python3 scripts/upgrade.py recover --state /absolute/data/directory/deploy
```

For a direct user-service conversion, recovery stops the temporary launcher, restores the saved files, reloads systemd, and restarts the original service if it was running before. For a system-service conversion, recovery first stops and disables the replacement user service, then prints the administrator restore command. That command verifies the user service is stopped and disabled before restoring the original system unit, enabled state, and lingering state. Repeat `recover` afterward to close the saved operation.

If database rollback is incomplete, a newer edit conflicts with a preserved file, or the candidate was already accepted, automatic old-service recovery is blocked. The deployment report identifies the remaining recovery action. After acceptance, the bot may have consumed messages or performed work. Switching old code and data automatically would lose that evidence, so the service remains stopped when accepted startup is unhealthy.

Do not remove activation records or migration journals to force startup. Preserve the report, repair the recorded cause, and resume the same activation or perform the documented data recovery.

## Exit status

- `0`: plan succeeded, upgrade is healthy, or recovery completed.
- `2`: a prepared operation needs the printed administrator step or further recovery.
- `1`: an operation was blocked or failed. Its private journal remains available.
