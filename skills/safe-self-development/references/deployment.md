# Guarded self-deployment and rollback

A long-lived bot cannot guarantee recovery from its own bad startup. **The deployment guard must run outside BlackDogBot's process** (as a separate systemd user transient unit or service). Never run the guard solely as a child of the bot being restarted.

## Required invariants

- Immutable **known-good** release kept separate from candidate release. No in-place rewriting of the active code directory while the service is running.
- Persistent config/DBs/sessions/secrets remain outside releases (`~/.blackdogbot`). Source rollback does **not** undo database migrations; require a separately tested database backup/rollback for incompatible schema changes.
- New candidate runs `pnpm install --frozen-lockfile`, TypeScript check, targeted tests and `pnpm test:fast` **before** activation.
- Service launcher resolves an atomically-swapped `current` symlink to a versioned release worktree. External supervisor records previous and candidate revisions.
- After activation, the supervisor restarts the service, checks `ActiveState=active`, a new PID, startup logs, and a stable observation interval. If unhealthy, atomically re-point `current` to previous release, restart and recheck. Do not use `git reset --hard` or delete candidate code.
- Each attempted deployment leaves a result JSON and journal excerpt in `~/.blackdogbot/deploy/reports/`. Mark failure and leave the candidate release for diagnosis; cap retries to prevent endless loops.
- **Telegram:** before activation report "tested / preparing activation"; supervisor independently reports "activating", "healthy" or "rolled back" to the initiating chat using a bounded HTTPS request to the Telegram Bot API. Never log or show bot tokens, credentials, or full exception stacks containing secrets. On notification failure, save the report and do not claim a delivered alert.
- Only an explicit request to update/deploy BlackDogBot should activate a new release; MCP config changes should use registry reload, not full application replacement.

## Independent supervisor

See `scripts/guarded-release.py` for preparation, activation and rollback machinery. The bot should launch this as a **detached systemd unit** after saving its candidate revision, so the supervisor survives bot restarts. The permanent launcher path is *outside* the mutable source tree.

If the protected service has not been bootstrapped to run the stable release launcher, do not attempt activation with an in-process restart. Prepare the candidate, explain that a one-time migration to the guarded launcher is needed, and install that launcher through the guarded bootstrap procedure.

**No guarantees for failures outside this boundary:** power loss, a broken OS/user systemd manager, insufficient disk space, revoked Telegram credentials, or irreversible database migrations can prevent autonomous recovery. Report these honestly.

## Iteration after failure

On the next healthy agent turn, read the last deployment report and associated logs. Diagnose, edit the candidate in a separate worktree, create a new candidate revision and rerun validation. Do not blindly reactivate the same failed commit or endlessly retry on startup failures. The external guard handles recovery to the known-good release; the model handles source debugging after the bot is back online.
