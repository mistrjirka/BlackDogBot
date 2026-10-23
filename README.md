# BlackDogBot

**Self-hosted AI assistant for Linux**, controlled through Telegram or Discord. BlackDogBot can use tools, browse the web, manage files, load reusable skills, and run scheduled tasks. It works with OpenAI-compatible local model servers as well as supported hosted providers.

BlackDogBot runs under your **systemd user session**. Its optional web services use Docker, and application updates use a tested release snapshot with automatic rollback when startup fails.

## Quick start (Linux)

Requirements: **Node.js 22+**, **Git**, **Bash**, and **pnpm** (installed by the wizard if missing). Docker Engine with the Compose plugin is optional but recommended for local web research. A running user systemd manager is required for the managed service.

```sh
curl -fsSL https://raw.githubusercontent.com/mistrjirka/BlackDogBot/main/scripts/bootstrap.sh | sh
```

The bootstrap script clones the source into `~/.local/share/blackdogbot/source` and launches the interactive installer. It **does not use sudo**, doesn't overwrite an existing configuration, and asks for model, messaging, and optional Docker settings. The installer registers a **systemd user service** and, by default, prepares a guarded tested release so future updates can roll back automatically.

For a review-before-execution installation, or when you want to inspect the exact script:

```sh
curl -fsSLo /tmp/blackdogbot-bootstrap.sh https://raw.githubusercontent.com/mistrjirka/BlackDogBot/main/scripts/bootstrap.sh
less /tmp/blackdogbot-bootstrap.sh
sh /tmp/blackdogbot-bootstrap.sh
```

`curl | sh` executes code fetched from the repository's moving `main` branch: use it only if you trust the source. For a reproducible installation, inspect a tagged or commit-pinned source instead. **Run the installer as your ordinary user, never as root.** Prompts require an interactive terminal.

Already have a checkout? Run `./install.sh` **only for a fresh installation**, not for upgrades. See the [installation guide](docs/installation.md).

## What it can do

- **Conversations:** Telegram and Discord, with configurable tool permissions.
- **Tool use:** Terminal processes, persistent files, database operations, knowledge search, and connected MCP servers.
- **Web research:** SearXNG for discovering sources, Scrapling for JavaScript-rendered page extraction, Playwright MCP for interaction or fallback.
- **Scheduling:** Recurring and one-off jobs with explicit per-task tool permissions.
- **Skills:** Bundled and user-defined Markdown skills (`SKILL.md`), loaded as needed.
- **Long-running work:** Agent-driven task execution, context management, and recovery workflows.

A scheduled research job can, for example, search for recent articles with SearXNG, fetch and render them with Scrapling, then send a digest to Telegram. A task must explicitly list the tools it needs; unavailable tools cause a recorded failure rather than silent omission.

## Operation

```sh
systemctl --user status blackdogbot.service
journalctl --user -u blackdogbot.service -f
systemctl --user restart blackdogbot.service
docker compose -f ~/.blackdogbot/docker-compose.yaml ps
```

To keep the user service running after logout or boot without a user login, an administrator can optionally run `sudo loginctl enable-linger "$USER"`. This is not required for an ordinary logged-in session.

Settings, prompts, MCP registry, schedules, and runtime data live under `~/.blackdogbot/`. **Never commit `config.yaml`, `mcp-servers.json`, or `scrapling.env`**: they may contain credentials.

## Updates and rollback

Do **not** rerun `install.sh` to upgrade an existing installation. Application updates are performed by an independent user-level guarded release manager:

1. Prepare a chosen Git commit in an isolated worktree and run the typecheck and test suites.
2. Switch the user service to the tested release and verify startup; roll back the app if the new release fails.
3. When the app is healthy, check upstream Docker images for **SearXNG and Scrapling** and test newer image digests in isolated containers. Upgrade each service separately, restoring its prior image if functional checks fail.

Docker containers are updated on successful guarded application activation by default; pass `--skip-container-updates` to the release manager when you only want a code deployment. A Docker failure leaves the healthy bot release running but is recorded and reported.

See [guarded app updates](docs/guarded-self-update.md) and [guarded Docker updates](docs/guarded-container-update.md). Updates use immutable image digests even when upstream publishes moving `latest` tags.

## Documentation

| Guide | Covers |
|---|---|
| [Installation](docs/installation.md) | Prerequisites, interactive setup, optional Docker services |
| [Configuration](docs/configuration.md) | Model providers, messaging, MCP, runtime paths |
| [Commands](docs/commands.md) | Telegram and Discord commands |
| [Web research](docs/web-research-backends.md) | SearXNG, Scrapling, Playwright routing |
| [Guarded self-update](docs/guarded-self-update.md) | Release snapshots, health checks, application rollback |
| [Guarded container updates](docs/guarded-container-update.md) | Latest digest discovery, canaries, Docker rollback |
| [Architecture](docs/architecture.md) | Agent, services, skill and tool structure |
| [Testing](docs/testing.md) | TypeScript and Python regression tests |
| [Troubleshooting](docs/troubleshooting.md) | Diagnosing failed startup, MCP and scheduled jobs |

For source contributions, clone the repository, run `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, and `pnpm test:fast`. See [testing](docs/testing.md) and [code style](docs/code-style.md).

## License

GPL-2.0 — see [LICENSE](LICENSE).
