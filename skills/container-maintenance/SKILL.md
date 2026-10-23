---
name: container-maintenance
description: Check, test, update, recover, and roll back Docker Compose service images safely; especially the pinned Scrapling MCP scraper container and SearXNG search.
userInvocable: true
disableModelInvocation: false
---

# Docker container maintenance (skill-first)

This is **not** a special model-facing Docker tool. Use existing `run_cmd`, file tools, and the separately installed `scripts/guarded-container-update.py` supervisor. Load `references/update-procedure.md` using `get_skill_file` before changing a container.

## When to use

When explicitly asked to install, upgrade, restart, troubleshoot, or replace a self-hosted Docker service. Check for available updates on request, but **do not automatically pull every moving `latest` tag or restart healthy production services**. An MCP setup change usually requires only registry reload, not Docker recreation.

## Procedure

1. Identify the Compose project and actual service with `docker compose -f ~/.blackdogbot/docker-compose.yaml config --services`, `docker ps`, and `docker inspect`. Determine which container is serving the MCP endpoint and whether its callers or scheduled tasks depend on it.
2. Check upstream image tags/digests and release notes. Prefer a release-specific tag or immutable digest; check browser/dependency changes. Never assume that a remote `latest` tag corresponds to a release number. Compare deployed digest with remote digest.
3. Use the guarded update procedure. For Scrapling, the updater **pulls and verifies a candidate in an isolated canary**, then replaces **only** the Scrapling Compose service, checks JavaScript-rendered page content and an MCP screenshot, and restores the old Compose/image if anything fails.
4. Use `systemd-run --user` to run the updater independently from the bot when restarts might interrupt the current task. Provide clear Telegram status reports and save private JSON diagnostics. Never stop every Compose service or use `docker compose down` during a targeted update.
5. Re-run actual MCP tools, Docker health, and agent-visible tool discovery after each change. A healthy container with broken tool schemas/rendering is a failure.
6. Keep the previous pinned image locally and the old Compose configuration until the new version has been validated. Never prune volumes, browser profiles, cookies, images, or user data as part of ordinary updates.

## Security and safety

- Docker access is effectively host-root access. Follow the user's explicit request; do not expose Docker APIs, TCP sockets, host filesystem mounts, or unrestricted tool execution merely for convenience.
- Bind MCP ports to `127.0.0.1`; use authenticated Streamable HTTP. Keep credentials in a user-private `0600` env file, never in the image or Git.
- Respect resource limits and only use trusted publisher images. Maintain a pin/digest even when upstream labels images `latest`.
- Do not claim that stealth browsing guarantees bypassing CAPTCHA or other access controls; detect failures and report them.
- Keep rollback changes outside the bot process. After a failed update, preserve logs and the candidate digest for analysis, rather than repeatedly trying the same broken image.

## What to report

Image before/after, upstream version, immutable digest, tool-discovery and functional tests, whether a container was recreated or merely inspected, health state, and retained rollback artifacts. Clearly distinguish **prepared**, **activated**, and **verified healthy**.
