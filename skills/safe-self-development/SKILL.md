---
name: safe-self-development
description: Use when the user asks to extend BlackDogBot with new capabilities, modify source code or Telegram behavior, add tools, fix a regression, or update the bot itself. Architecture guidance, iterative test workflow, and guarded out-of-process deployment/rollback.
userInvocable: true
disableModelInvocation: false
---

# Extend BlackDogBot safely

Work in the trusted source checkout, not a production release directory. Read [references/architecture.md](references/architecture.md) to find the relevant subsystem. Read [references/development.md](references/development.md) before editing, and [references/deployment.md](references/deployment.md) before attempting any live change or restart. Use `get_skill_file` for these reference pages.

## Choose the least invasive capability

1. Can existing tools, prompts, configuration, or a skill solve the request? Prefer those. For Docker image upgrades and service health, use the `container-maintenance` skill rather than editing application source.
2. Is it an independent capability with its own tools or service, such as a browser, Git integration, file search, or third-party API? **Prefer an external MCP server**, registered by the `mcp-management` skill, rather than adding a dedicated BlackDogBot tool.
3. Does the request change the bot's own Telegram message processing, session lifecycle, permissions, tool invocation, context accounting, or another core integration? This requires source changes to BlackDogBot. Work through tests and a guarded deployment, not a new MCP server.
4. If an MCP server requires privileged OS access, network exposure, credentials, or account consent, explain the boundary; do not circumvent it with a self-edit.

## Editing workflow

- Identify the exact subsystem and inspect its tests, public schemas, and call sites. Prefer small changes and explain interface/behavior effects. Avoid duplicate tools, redundant wrappers, global configuration hacks, and over-specific system-prompt rules.
- Preserve unrelated working tree changes; never run `git reset --hard`, `git clean -fd`, or discard a user's uncommitted work. Prefer a temporary Git worktree for experimental edits.
- Test incrementally. Every failed test should produce a diagnosis, a changed hypothesis, and a new bounded test. Do not repeat identical commands or claim a fix from logs alone.
- Run `pnpm install --frozen-lockfile` for dependencies when needed, `pnpm exec tsc --noEmit`, focused `pnpm exec vitest run ...`, `pnpm test:fast`, and `git diff --check`. For command details, read [references/development.md](references/development.md).
- If the user explicitly requests an app update from upstream, follow `mcp-management/references/self-update.md` for source inspection and authorization, then the guarded release procedure here for safe activation.
- Before deployment, preserve the *last known-good* release. Never compile/run candidate code as the only remaining copy of the bot.
- Deploy only with an **out-of-process** supervisor capable of restoring the previous release after startup/health failure. A bot process cannot reliably undo its own broken startup. Read [references/deployment.md](references/deployment.md). If that supervisor is not installed, keep changes in a tested candidate revision and report the need for safe activation rather than restarting unguarded.

## Transparency and failed attempts

Tell the user what is being changed and why. Report code revision, which tests actually passed, and whether it is only staged or live. The external supervisor must send Telegram progress and a final status including rollback details. On failure preserve the candidate code, command output, and journal logs for the next iteration. Recovery attempts should be bounded; do not flip repeatedly between unstable releases.

Never silently modify Telegram authorization, secrets, user accounts, payment settings, or external publishing behavior. Require explicit user permission for potentially destructive changes; a general request to add a feature does not imply permission to erase files or bypass access controls.
