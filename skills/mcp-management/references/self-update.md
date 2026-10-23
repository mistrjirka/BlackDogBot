# Self-update BlackDogBot (explicit user request only)

For "update yourself", do not simply run `git pull && systemctl restart` from inside the bot. A bad update can prevent the bot from starting, leaving it unable to undo its own changes. Use the separate `safe-self-development` skill and its guarded release supervisor. An MCP server installation/update does **not** authorize changing BlackDogBot source.

## 1. Identify and inspect

From the trusted **source checkout**, not the active release snapshot:

```bash
git rev-parse --show-toplevel
git status --short
git branch -vv
git remote -v
git fetch --prune origin
git log --oneline HEAD..'@{upstream}'
git diff --stat HEAD..'@{upstream}'
```

Do not guess the upstream branch, force push, discard user edits, or run arbitrary remote scripts. Inspect package/lockfile changes, release notes, migration requirements and new privileges. On conflicting tracked changes, stop rather than stashing or resetting without user consent. If already current, report it and stop.

## 2. Test a candidate away from the active bot

The committed source update can be tested by the independent guarded manager:

```bash
python3 scripts/guarded-release.py prepare --repo "$PWD" --revision '@{upstream}'
```

It creates a detached versioned worktree under `~/.blackdogbot/deploy/releases/`, runs `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, and `pnpm test:fast`. It does **not** replace the live release. A failing candidate is preserved with logs in `~/.blackdogbot/deploy/reports/` for the agent to diagnose.

For one-off source edits, commit the tested candidate in the trusted source checkout before preparing. Re-running an identical failed revision is not recovery; change the code and test a **new commit**.

## 3. Safely activate

Read `safe-self-development/references/deployment.md` first. The user-level service must have been bootstrapped **once** to an external stable launcher. That procedure is guarded as well. Do not directly replace or rewrite the running source checkout.

The independent supervisor is started through the user systemd manager **after the current bot turn has finished**, for example using a uniquely named transient timer:

```bash
systemd-run --user --on-active=20s --unit=blackdog-activate-<unique-id> \
  /usr/bin/python3 /home/jirka/.local/lib/blackdogbot/guarded-release.py \
  activate --revision <tested-full-git-sha> --chat-id <authorized-telegram-chat-id>
```

Validate the exact paths and chat ID rather than copying placeholder values. Report the planned update in Telegram before scheduling. The manager posts independent Telegram progress and a final health/rollback result.

The manager atomically switches the `current` release symlink, restarts BlackDogBot, checks the new PID, startup and Telegram-polling logs, and restores the previous known-good release if health checks fail. Neither the failed candidate nor its logs are deleted.

## 4. After an update or rollback

Read the latest `~/.blackdogbot/deploy/reports/latest.json` (small, sanitized metadata) and its journal log path. Confirm `systemctl --user is-active blackdogbot.service`, actual revision under the `current` symlink, working MCP connections, and normal message handling. Report **which revision is live**, not just which commit exists in Git.

After a rollback, investigate saved logs using the `safe-self-development` skill, patch a separate worktree, rerun tests, and prepare another candidate. Do not retry the same failing revision indefinitely.

**Limits:** An external user-systemd manager may itself fail; power outages, invalid Telegram credentials, disk exhaustion, broken OS dependencies, and irreversible database migrations are outside automatic code rollback. Before incompatible data migrations, make a separately restorable backup and test it. Never claim a rollback succeeded unless the previous service was actually observed healthy.
