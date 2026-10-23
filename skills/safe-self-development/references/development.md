# Develop and test a source change

1. Find the **source checkout** with `git rev-parse --show-toplevel` from the intended project, and inspect `git status --short`, `git branch -vv`, `git remote -v`. Never develop inside the immutable release snapshots managed by the watchdog.
2. For a substantial change, create a named feature branch or separate `git worktree add` directory, preserving all current edits. Commit only relevant files. Prefer independently reproducible tests.
3. Read the relevant code, schemas and call sites using `rg`, `sed`, `read_file`. Follow existing interfaces. Keep runtime and user data under `~/.blackdogbot` outside the repository.
4. Install dependencies with `pnpm install --frozen-lockfile` if needed; use the checkout's lockfile. Confirm `node --version` and `pnpm --version` against `package.json`.
5. Verify, in this order:
   ```bash
   pnpm exec tsc --noEmit
   pnpm exec vitest run tests/path/to/relevant.test.ts
   pnpm test:fast
   git diff --check
   ```
   For protocol/vision/terminal changes, add integration tests plus a small **live** request to the actual provider/service. A successful mock alone is insufficient.
6. If tests fail, capture exact command, exit code, relevant output and a revised hypothesis; don't repeat unchanged commands. Repair in the candidate checkout and rerun affected tests. Never silence tests, weaken security, or skip type-check just to get a green result.
7. Summarize changes, test counts, known limitations, revision and deployment readiness. Push only if user has authorized publishing, and do not confuse "pushed" with "running".

For startup issues, check:
```bash
systemctl --user show blackdogbot.service -p ActiveState -p MainPID -p ExecMainStartTimestamp -p NRestarts
journalctl --user -u blackdogbot.service --since '10 minutes ago' --no-pager
```

A new feature can need an MCP configuration refresh instead of a daemon restart. See `mcp-management` first.

For application self-updates, use source inspection and test worktrees; only an **external** supervisor may switch the active release, restart, observe startup, and roll back.
