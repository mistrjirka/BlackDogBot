# Test-and-rollback procedure for Docker service images

For an approved SearXNG or Scrapling Docker upgrade, read `docs/guarded-container-update.md` from the BlackDogBot source checkout before running commands.

## Inspect first

Inspect active Compose services and the precise pinned image. Compare with the upstream digest, not a moving `latest` label:

```bash
docker compose -f ~/.blackdogbot/docker-compose.yaml config --services
docker compose -f ~/.blackdogbot/docker-compose.yaml config --images
docker inspect betterclaw-scrapling --format '{{.State.Health.Status}} {{.Image}}'
docker pull pyd4vinci/scrapling:latest  # or searxng/searxng:latest
docker image inspect pyd4vinci/scrapling:latest --format '{{index .RepoDigests 0}}'
```

The supervisor also supports `python3 ~/.local/lib/blackdogbot/guarded-container-update.py --service scrapling --check-only`, returning the pinned/available digests without recreating the running container.

Reading a digest/pulling an image does not recreate the existing container. If the digest is unchanged, stop. Read upstream release notes before replacing a major version.

## Guarded upgrade

Use the installed independent `guarded-container-update.py` supervisor, launched via `systemd-run --user` for transparency and isolation. The user must explicitly request the upgrade. Supply the verified `pyd4vinci/scrapling@sha256:<64-hex>` digest, not `:latest`. Supply the Telegram chat ID if known so the supervisor can report progress independently from the bot. Never expose credentials in logs or chat.

The supervisor: backs up Compose, pulls candidate, runs an isolated canary on localhost port 18734, checks MCP discovery + JavaScript rendering + a real screenshot, recreates only `scrapling`, verifies the production MCP on port 18733, and automatically restores the old Compose/image if verification fails. It does not restart unrelated containers or BlackDogBot. Reports: `~/.blackdogbot/deploy/container-reports/latest.json`.

To return to a previously healthy digest, run the same guarded upgrade with that old digest. Preserve old Docker images and configuration until this rollback path is no longer required.

## Safety

Use localhost-only published MCP ports and a private auth token in `~/.blackdogbot/scrapling.env`. Never mount `/var/run/docker.sock` in a scraper or expose a Docker API. A Docker user has powerful host privileges: do not update unrelated containers just because they are tagged `latest`. Report CAPTCHA or site blocks; no open-source browser can promise universal bypass.

The same updater handles **Scrapling and SearXNG**, each with its own canary checks, rollback, and report. A successful guarded app release triggers both sequentially by default; add `--skip-container-updates` for application-only deployment.
