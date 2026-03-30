# BlackDogBot

A proactive AI assistant daemon for Linux. It runs as a long-lived process, communicates via Telegram and/or Discord, and executes structured jobs, skills, and scheduled tasks autonomously.

## Features

- Multi-platform messaging for Telegram and Discord
- Permission-aware tool access (`ignore`, `read_only`, `full`)
- Autonomous scheduled tasks (`cron`, `interval`, `once`)
- Job graph execution with structured node inputs/outputs
- Skill system with reusable `SKILL.md` capabilities
- Persistent knowledge with embeddings + vector search
- Editable prompt system stored under `~/.blackdogbot/prompts/`

## Installation

### Prerequisites

- Node.js 22+
- pnpm
- Git (recommended for updates)
- Docker + Docker Compose (optional, for local SearXNG and Crawl4AI)

### Quick install

```bash
# Run the interactive installer
./install.sh

# Start the daemon
pnpm start
```

See [Installation Guide](docs/installation.md) for manual setup and Docker details.

## Usage

- Start the daemon with `pnpm start`.
- Talk to the bot in Telegram or Discord in natural language.
- In Telegram, run `/start` then `/help` to see available commands.
- In Discord, use the bot in any allowed channel; `/cancel` is available as a slash command.
- Enable Telegram notifications for scheduled tasks with `/notifications_enable`.

See [Commands Guide](docs/commands.md) for full command reference.

## Troubleshooting

- Bot not responding: verify bot token in `~/.blackdogbot/config.yaml`, then restart with `pnpm start`.
- Web tools unavailable: ensure optional services are running (`docker compose -f ~/.blackdogbot/docker-compose.yaml up -d`).
- Embedding model issues: first run downloads model files; check internet connection and retry.
- Cron notifications missing: verify channel notifications are enabled and task has `notifyUser: true`.
- Native runtime crash on startup (`ELIFECYCLE` with exit code `132`): run `pnpm rebuild better-sqlite3 sharp onnxruntime-node` and retry. If it still fails with `132`, your CPU likely cannot run the prebuilt native binary.

See [Troubleshooting Guide](docs/troubleshooting.md) for detailed fixes.

## Documentation

| Document | Description |
|----------|-------------|
| [Installation Guide](docs/installation.md) | Install, manual setup, and Docker services |
| [Commands Guide](docs/commands.md) | Telegram and Discord command reference |
| [Configuration Guide](docs/configuration.md) | `config.yaml` reference and data paths |
| [Troubleshooting Guide](docs/troubleshooting.md) | Common issues and recovery steps |
| [Architecture](docs/architecture.md) | Internal architecture and components |
| [Testing Guide](docs/testing.md) | How to run and write tests |
| [Code Style](docs/code-style.md) | Coding conventions and patterns |

## License

GPL-2.0
