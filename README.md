# BlackDogBot

A proactive AI assistant daemon for Linux. It runs as a long-lived process, communicates via Telegram and/or Discord, and executes structured jobs, skills, and scheduled tasks autonomously.

## Documentation

| Document | Description |
|----------|-------------|
| [Installation Guide](docs/installation.md) | How to install and configure BlackDogBot |
| [Architecture](docs/architecture.md) | System architecture and components |
| [Testing Guide](docs/testing.md) | How to run and write tests |
| [Code Style](docs/code-style.md) | Coding conventions and patterns |

## Features

- **Multi-Platform Messaging** - Telegram and Discord support with unified interface
- **Channel Permissions** - Three permission levels per channel: `ignore`, `read_only`, `full`
- **Jobs** - Directed acyclic graphs of typed nodes with Zod-validated I/O schemas. 7 node types: `manual`, `python_code`, `curl_fetcher`, `crawl4ai`, `searxng`, `output_to_ai`, `agent`.
- **Skills** - Pluggable capabilities described in `SKILL.md` files (OpenClaw-compatible format). Skills go through a setup phase and are then callable by the agent.
- **Scheduled Tasks** - Cron-like periodic tasks with `cron`, `interval`, and `once` schedule types, executed by a dedicated cron agent.
- **Notification Broadcasting** - Cron tasks can broadcast to multiple channels simultaneously
- **Knowledge** - Persistent vector database (LanceDB + configurable local/OpenRouter embeddings) for storing and retrieving information across sessions.
- **Externalized Prompts** - All agent prompts live in `~/.blackdogbot/prompts/` and can be modified at runtime via tools or reset to factory defaults.

## Quick Start

```bash
# Run the interactive installer
./install.sh

# Start the daemon
pnpm start
```

See [Installation Guide](docs/installation.md) for detailed setup instructions.

## Architecture

```
src/
├── agent/              # Main agent, cron agent, base agent class
├── defaults/prompts/   # Factory default prompt templates
├── jobs/               # Graph validation, schema compatibility
├── platforms/          # Platform adapters (Telegram, Discord)
│   ├── telegram/       # Bot, handler, commands, adapter
│   └── discord/        # Bot, handler, adapter
├── services/           # 16 singleton services
├── shared/             # Types, schemas, constants
├── skills/             # Skill parser, setup runner
├── tools/              # 27+ agent tools
├── utils/              # ID generation, path helpers
└── index.ts            # Entry point
```

See [Architecture](docs/architecture.md) for full details.

## Services

| Service | Purpose |
|---|---|
| `ConfigService` | Loads and validates `~/.blackdogbot/config.yaml` |
| `LoggerService` | Structured logging with configurable levels |
| `AiProviderService` | Creates LLM model instances (OpenRouter / OpenAI-compatible) |
| `RateLimiterService` | Per-provider TPM/RPM rate limiting via Bottleneck |
| `PromptService` | Loads, caches, and resolves prompt templates with `{{include:}}` directives |
| `EmbeddingService` | Configurable local/OpenRouter embeddings (default local Qwen3 ONNX) |
| `VectorStoreService` | LanceDB vector storage with cosine similarity search |
| `KnowledgeService` | High-level knowledge CRUD over the vector store |
| `JobStorageService` | Persists jobs, nodes, and test cases to `~/.blackdogbot/jobs/` |
| `JobExecutorService` | Executes job graphs in topological order with I/O validation |
| `SkillLoaderService` | Discovers and loads skills from configured directories |
| `SkillStateService` | Persists skill setup state |
| `SchedulerService` | Manages cron/interval/once scheduled tasks |
| `MessagingService` | Platform-agnostic messaging adapter registry |
| `ChannelRegistryService` | Manages channel permissions and notification settings |
| `ToolRegistryService` | Filters tools based on channel permissions |

## Channel Permissions

Each channel (Telegram chat or Discord channel) has a permission level:

| Level | Description |
|-------|-------------|
| `ignore` | Bot does not respond to messages |
| `read_only` | Bot responds but cannot perform destructive operations (no `run_cmd`, `write_file`, `add_cron`, etc.) |
| `full` | Full access to all tools |

**Default permissions:**
- Telegram: `full` (auto-registered on first message)
- Discord: `read_only` (auto-registered on first message)

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and registration |
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/reset [name\|all]` | Reset prompts to factory defaults |
| `/factory_reset` | Full nuclear reset of all data |
| `/notifications_enable` | Enable cron notifications for this chat |
| `/notifications_disable` | Disable cron notifications for this chat |
| `/status` | Show current chat status (permission, notifications) |

## Testing

```bash
pnpm test:unit      # Unit tests only (fast)
pnpm test:core      # Core integration tests
pnpm test:jobs      # Job-related tests (slower)
pnpm test:fast      # Unit + core (excludes job tests)
pnpm test           # All tests
```

See [Testing Guide](docs/testing.md) for full details.

## Data Storage

All persistent data is stored under `~/.blackdogbot/`:

```
~/.blackdogbot/
├── config.yaml          # Main configuration
├── channels.yaml        # Channel permissions and notification settings
├── prompts/             # Agent prompt templates (editable)
├── jobs/                # Job and node definitions (JSON)
├── knowledge/lancedb/   # Vector database files
├── skills/state/        # Skill setup state
├── cron/tasks/          # Scheduled task definitions (JSON)
├── logs/                # Application logs
├── workspace/           # Working directory for file operations
├── databases/           # SQLite databases
└── rss-state/           # RSS feed state
```

## License

GPL-2.0
