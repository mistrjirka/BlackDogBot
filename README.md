# BlackDogBot

**Self-hosted AI assistant for Linux**, controlled through Telegram or Discord. BlackDogBot can use tools, browse the web, manage files, load reusable skills, and run scheduled tasks. It works with OpenAI-compatible local model servers as well as supported hosted providers.

BlackDogBot runs under your **systemd user session**. Its optional web services use Docker, and application updates use a tested release snapshot. Failed candidate validation can restore the previous release before message and task processing starts.

## Quick start (Linux)

Requirements: **Node.js 22.13.0+**, **Python 3.9+**, **Git**, **Bash**, and the **pnpm version declared in `package.json`** (installed by the wizard when needed). Docker Engine with the Compose plugin is optional but recommended for local web research. A running user systemd manager is required for the managed service.

```sh
curl -fsSL https://github.com/mistrjirka/BlackDogBot/releases/latest/download/blackdogbot-install.sh | sh
```

The bootstrap script clones the source into `~/.local/share/blackdogbot/source` and launches the interactive installer. It **does not use sudo**, does not overwrite an existing configuration, and asks for model, messaging, and optional Docker settings. The installer offers **three MCP servers** (SearXNG, Scrapling, Playwright), registers a **systemd user service**, and, by default, prepares a guarded tested release so future updates can roll back automatically. The pinned Docker images and Node MCP runtimes support both Linux AMD64 and ARM64.

For a review-before-execution installation, or when you want to inspect the exact script:

```sh
curl -fsSLo /tmp/blackdogbot-bootstrap.sh https://github.com/mistrjirka/BlackDogBot/releases/latest/download/blackdogbot-install.sh
less /tmp/blackdogbot-bootstrap.sh
sh /tmp/blackdogbot-bootstrap.sh
```

The release asset pins an exact tested commit. The `latest` download selects the newest published stable version. See [releases](docs/releases.md) for a fixed version and checksums. **Run the installer as your ordinary user, never as root.** Prompts require an interactive terminal.

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

## Local agent tests

With the managed service running, use `pnpm ask:local -- --max-steps 12 --timeout 120 "What can PS4 firmware 12.50 run?"` to send a question in a fresh isolated chat through the authenticated Brain Interface. Add `--verbose` to inspect `run_code` calls and results. For repeatable tests, `--chat-id cli-NAME` selects an isolated chat. **New CLI chat IDs have no tool permissions until separately registered through the channel registry**; with `ignore` permission the model cannot call research tools. This executes real agent tools using normal permissions once authorized; it is **not** a security sandbox. Tests may queue while a Telegram run is active, and the CLI has a stop/timeout safeguard.

## Updates and rollback

Use the standalone upgrade command for older installations or the package command
after updating to v0.2.0:

~~~sh
pnpm upgrade:bot plan --repo /absolute/path/to/BlackDogBot
pnpm upgrade:bot apply --repo /absolute/path/to/BlackDogBot
~~~

The command prepares and tests an exact release, refreshes the supervisor, stops
the service, resolves supported legacy database paths, verifies a data snapshot,
and applies supported migrations. The candidate validates before it can process
messages or tasks. A failure before acceptance restores unchanged migration-owned
files and compatible previous code. A failure after acceptance stops for explicit
recovery because the bot may already have produced external effects.

Container updates are skipped by default by this entry point. Optional container
upgrades use separate canary checks and service-local rollback.

See [upgrading older installations](docs/upgrade.md), [release assets](docs/releases.md),
[guarded app updates](docs/guarded-self-update.md), and
[guarded Docker updates](docs/guarded-container-update.md). Do not rerun
`install.sh` over an existing installation.

## Documentation

| Guide | Covers |
|---|---|
| [Installation](docs/installation.md) | Prerequisites, interactive setup, optional Docker services |
| [Upgrading](docs/upgrade.md) | One upgrade command, older services, recovery |
| [Releases](docs/releases.md) | Versioned downloads, checksums, publication |
| [Configuration](docs/configuration.md) | Model providers, messaging, MCP, runtime paths |
| [Commands](docs/commands.md) | Telegram and Discord commands |
| [Web research](docs/web-research-backends.md) | SearXNG, Scrapling, Playwright routing |
| [Guarded self-update](docs/guarded-self-update.md) | Release snapshots, health checks, application rollback |
| [Data migrations](docs/data-migrations.md) | Historical task formats, explicit imports, scoped recovery |
| [Data backups](docs/data-backups.md) | Persistent-data snapshots, verification, staged restore |
| [Guarded container updates](docs/guarded-container-update.md) | Latest digest discovery, canaries, Docker rollback |
| [Architecture](docs/architecture.md) | Agent, services, skill and tool structure |
| [Testing](docs/testing.md) | TypeScript and Python regression tests |
| [Troubleshooting](docs/troubleshooting.md) | Diagnosing failed startup, MCP and scheduled jobs |

For source contributions, use the declared pnpm version and run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test:fast`, `pnpm test:python`, and `pnpm build`. GitHub CI runs these checks on Linux with Node 22, 24, and 26. Version tags publish release assets only after the same checks pass. See [testing](docs/testing.md) and [code style](docs/code-style.md).

## License

GPL-2.0 — see [LICENSE](LICENSE).

Programmatic tool calling: [blackboard and data-only `run_code`](docs/programmatic-tool-calling.md).
