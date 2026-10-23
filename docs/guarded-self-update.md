# Install the independent self-update supervisor (one-time setup)

**Compatibility:** this procedure works only when `blackdogbot.service` is a
**user-level systemd service** with a guarded release launcher. The optional
system-level service created by the current `install.sh` requires migration
first. The installer itself is not an updater; never rerun it to upgrade code.

The `safe-self-development` skill contains the full architecture and development workflow. The release manager implementation is `scripts/guarded-release.py`. It is a regular Python program that runs through the user systemd manager **outside the BlackDogBot daemon**, not a new model-facing tool.

### Initial migration

1. Verify the trusted source checkout, current `blackdogbot.service` systemd unit and `~/.blackdogbot` runtime files. Confirm the service is currently healthy.
2. Copy the *reviewed* release manager to a protected path outside the repository; this copy must survive updates:
   ```bash
   install -D -m 700 scripts/guarded-release.py "$HOME/.local/lib/blackdogbot/guarded-release.py"
   ```
3. Prepare a snapshot of the current known-good commit without modifying the running service:
   ```bash
   /usr/bin/python3 "$HOME/.local/lib/blackdogbot/guarded-release.py" prepare \
     --repo /home/jirka/programy/better-claw --revision <known-good-full-sha>
   ```
   This is a **full test**, with `pnpm install --frozen-lockfile`, TypeScript, the fast test suite **and Python guarded-updater tests** in a separate worktree. The independent updater installed outside the repo must itself be updated from this reviewed source before using any newly added guard checks; do not assume changes to `scripts/guarded-release.py` automatically replace the external supervisor.
4. Once prepared, have the user systemd manager start the one-time `bootstrap` action (prefer a detached transient unit), supplying the verified Telegram chat id for status messages. The script installs an external stable wrapper, adds a systemd drop-in, restarts the bot, and checks healthy startup. If startup fails it removes the drop-in, restores the original unit command and attempts to restart the prior service.
5. Confirm the service is running, `~/.blackdogbot/deploy/current` points at the tested known-good commit and `latest.json` reports `bootstrap_healthy`.

The active **source repository** remains available for editing. The running **release worktree** is isolated. Rebuild and restart are never performed on the only active code copy.

### Future updates

1. Modify/test source in a separate checkout or branch and commit the candidate locally.
2. Run `guarded-release.py prepare --revision <candidate-full-sha>`.
3. Review the test logs and release marker.
4. **After telling the user**, schedule the external `activate` command using `systemd-run --user --on-active=20s --unit=<unique-deploy-unit> ...`, so the initiating bot turn can end safely.
5. The supervisor posts Telegram statuses, changes the current symlink atomically, restarts, checks new PID and startup logs for a stable interval. If checks fail, it restores the previous release, restarts, retains the bad release and logs, and posts a rollback report.
6. On the next bot turn inspect `~/.blackdogbot/deploy/reports/latest.json`; a `rolled_back` status is also added to the main agent's short runtime context.

The guard's reports are user-private files. Avoid exposing credentials in logs, and do not send the chat's bot token to the user. The report records the failed revision, healthy previous revision and journal path, allowing the model to iterate without losing evidence.

This is a process recovery mechanism, not a guarantee against incompatible database migrations, OS/power failures or permanently broken user systemd. External changes to runtime data require their own backup and migration plan.
