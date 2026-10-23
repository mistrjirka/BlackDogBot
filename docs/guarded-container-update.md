# Updating the Scrapling Docker MCP server

BlackDogBot's default web stack is **SearXNG** for search, **Scrapling** for JavaScript-rendered page scraping and browser sessions, and **Playwright MCP** for complex site interaction. Crawl4AI was retired from the active host in October 2026; its old image and backups are retained for rollback.

## Running configuration

- Docker Compose: `~/.blackdogbot/docker-compose.yaml`.
- Container: `betterclaw-scrapling` (the installation script uses `blackdogbot-scrapling` for new installations).
- MCP URL: `http://127.0.0.1:18733/mcp`, authenticated with a bearer token.
- Credentials: `~/.blackdogbot/scrapling.env` (mode `0600`); never store the token in Git or commands.
- MCP registry: `~/.blackdogbot/mcp-servers.json`, server id `scrapling`.
- Image: `pyd4vinci/scrapling@sha256:1d876879813759959bc4ba6fbb1ce8247ebbc2b67eee77b140baf7c80af6ae6b` (verified Scrapling 0.5).
- Only the host loopback interface exposes port 18733. Container port 8000 uses mandatory token authentication, not `--no-auth`.

The official image contains browsers and includes the `mcp --http` command. The server supports 16 MCP tools, including `browser_fetch_once`, persistent browser sessions, browser actions, HTML/Markdown extraction and **native inline PNG screenshot results**. No paid scraping API is required.

## How to detect a newer image

The upstream Docker registry has sometimes exposed only `latest` and `main`, even when release notes describe versioned images. Avoid depending on a possibly missing `0.5` tag.

```bash
# Discover the local pinned image:
docker compose -f ~/.blackdogbot/docker-compose.yaml config --images

# Resolve the current upstream image to a digest, without replacing containers:
docker pull pyd4vinci/scrapling:latest
docker image inspect pyd4vinci/scrapling:latest --format '{{index .RepoDigests 0}}'
```

Alternatively, the installed supervisor can check and report the newest official digest without restarting a service:

```bash
python3 ~/.local/lib/blackdogbot/guarded-container-update.py --check-only
```

Compare the returned digest with the one in Compose. If identical, no update is necessary. If different, read upstream release notes for breaking changes, then run the guarded updater below. `docker pull` does not recreate a running container, but does download an image and move the local floating tag.

## Guarded update from a skill or terminal

The updater defaults to the browser/MCP probe in the **guarded active release**
(`~/.blackdogbot/deploy/current/scripts/verify-scrapling.mjs`), rather than
mutable source files. If the guarded launcher has not been installed, use
`--probe` with an explicitly tested source checkout.

An explicitly requested upgrade uses `scripts/guarded-container-update.py`, installed independently at `~/.local/lib/blackdogbot/guarded-container-update.py`. For example, with a **verified** new image digest:

```bash
systemd-run --user --collect --unit=blackdog-scrapling-upgrade-<unique-id> \
  /usr/bin/python3 /home/jirka/.local/lib/blackdogbot/guarded-container-update.py \
  --image 'pyd4vinci/scrapling@sha256:<verified-64-hex-digest>' \
  --chat-id '<authorized-telegram-chat-id>'
```

The `container-maintenance` skill guides the agent through these operations using its existing terminal tools; no additional model-facing Docker control interface is introduced.

The supervisor performs the steps **in this order**:

1. Takes a timestamped backup of the Compose file, retaining the old image digest and Docker layers.
2. Pulls the immutable candidate image.
3. Starts a **separate canary container** on localhost port `18734`, without changing production.
4. Connects through real MCP, lists tools, renders a JavaScript-heavy page, opens a browser session, takes an inline screenshot, and closes the session.
5. Only if those tests pass, changes **just the Scrapling image field** and runs `docker compose up -d --no-deps --force-recreate scrapling`. No `docker compose down`, broad restart, volume deletion or image pruning.
6. Runs the same real MCP tests against production port `18733`. If they fail, atomically restores the old Compose file and recreates the old Scrapling container; reports whether rollback itself passed.
7. Stores a private JSON report at `~/.blackdogbot/deploy/container-reports/latest.json`, retains the old image, and sends progress and results via the independent Telegram notifier when an authorized chat ID is supplied.

A subsequent upgrade may change the MCP tool schemas. Check the discovered tools and any `allowedTools` list after an image change; do not assume a new upstream version is schema-compatible.

To intentionally revert a previously **healthy** new release, invoke the same updater with the previous digest recorded in its report, which performs the same canary and live verification before switching back.

## Verification

```bash
docker inspect betterclaw-scrapling --format '{{.State.Health.Status}} {{.Image}}'
docker compose -f ~/.blackdogbot/docker-compose.yaml config --services
node ~/.blackdogbot/deploy/current/scripts/verify-scrapling.mjs 18733
```

The probe tests genuine MCP tool discovery, JavaScript execution, a persistent browser session, and native screenshot output. Docker reporting `healthy` alone is insufficient.

This does **not** guarantee success against every CAPTCHA or bot-protected website. Those outcomes depend on server-side defenses, network identity, and account context. Report detected blocks rather than inventing extracted content.

The updater currently manages **Scrapling image upgrades only**; it intentionally does not automatically update or restart SearXNG, Playwright, or unrelated Docker services. Those require their own tested health probes and rollback policies.
