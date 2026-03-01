# BetterClaw Architecture

BetterClaw is a proactive AI assistant daemon for Linux, designed to run as a long-lived Node.js process. It operates autonomously to manage personal tasks, knowledge, and scheduled jobs, interacting through Telegram, Discord, and a dedicated Angular-based web UI.

## Tech Stack

- **Runtime**: Node.js (>= 22)
- **Language**: TypeScript
- **Package Manager**: `pnpm`
- **AI/LLM**: Vercel AI SDK (`ai`), OpenRouter, OpenAI
- **Embeddings**: Configurable local (Qwen3 ONNX) or OpenRouter embeddings
- **Databases**: LanceDB (Vector), SQLite (`better-sqlite3`)
- **Messaging**: Telegram (`grammy`), Discord (`discord.js`), WebSockets (`socket.io`)
- **Task Scheduling**: `node-cron`
- **Frontend**: Angular (located in `brain-interface/`)

## Directory Structure

```
src/
├── agent/              # AI agent logic (MainAgent, CronAgent, BaseAgent)
├── defaults/prompts/   # Factory default prompt templates
├── executors/          # Task executors (cron, jobs)
├── jobs/               # DAG-based job validation and execution logic
├── platforms/          # Platform adapters
│   ├── telegram/       # Telegram bot, handler, commands, adapter
│   ├── discord/        # Discord bot, handler, adapter
│   └── types.ts        # Shared platform interfaces
├── services/           # Singleton services managing state and logic
├── shared/             # Types, schemas, constants
│   ├── types/          # TypeScript interfaces
│   └── schemas/        # Zod validation schemas
├── skills/             # Pluggable capability definitions (SKILL.md parser)
├── tools/              # Agent tool definitions
├── utils/              # ID generation, path helpers, message splitting
└── index.ts            # Entry point

brain-interface/        # Angular web application
tests/
├── unit/               # Pure unit tests
├── integration/
│   ├── core/           # Core integration tests
│   └── jobs/           # Job-related integration tests
```

## Core Components

BetterClaw is built around several decoupled singleton services:

| Service | Responsibility |
| :--- | :--- |
| **AiProviderService** | Manages LLM connections across providers (OpenRouter, OpenAI-compatible). |
| **KnowledgeService** | Interface for the LanceDB vector store for RAG and memory. |
| **JobExecutorService** | Executes Directed Acyclic Graphs (DAG) of automated job nodes. |
| **SchedulerService** | Orchestrates cron, interval, and one-off scheduled tasks. |
| **SkillLoaderService** | Dynamically discovers and loads pluggable skills from the filesystem. |
| **ConfigService** | Loads and validates configuration from `~/.betterclaw/config.yaml`. |
| **MessagingService** | Platform-agnostic messaging registry (Telegram, Discord, BrainInterface). |
| **ChannelRegistryService** | Manages channel permissions and notification settings per channel. |
| **ToolRegistryService** | Filters available tools based on channel permission level. |

## Platform System

BetterClaw uses a unified platform interface for messaging:

```typescript
interface IPlatform {
  name: string;
  configKey: string;
  initialize(config: unknown, deps: IPlatformDeps): Promise<void>;
  stop(): Promise<void>;
  isEnabled?(config: unknown): boolean;
}
```

### Supported Platforms

| Platform | Library | Features |
|----------|---------|----------|
| Telegram | `grammy` | Full bot support, commands, typing indicators |
| Discord | `discord.js` | Full bot support, commands, typing indicators |

### Channel Permissions

Each channel has a permission level that controls available tools:

| Level | Tools Available |
|-------|-----------------|
| `ignore` | None (bot doesn't respond) |
| `read_only` | Safe tools only (no `run_cmd`, `write_file`, etc.) |
| `full` | All tools |

## Data Flow

1. **Input**: A message arrives via Telegram, Discord, or WebSocket (brain-interface).
2. **Registration**: Channel is auto-registered if new (Telegram=full, Discord=read_only).
3. **Permission Check**: ToolRegistry filters available tools based on channel permission.
4. **Orchestration**: `MainAgent` receives the input, retrieves relevant context from `KnowledgeService`, and decides on actions.
5. **Execution**: The agent calls one or more `tools` (e.g., `run_cmd`, `add_knowledge`, `execute_job`).
6. **Automation**: `SchedulerService` triggers `CronAgent` for background tasks, which may execute `Jobs` or `Skills`.
7. **Output**: The agent sends a response back to the originating platform via `MessagingService`.

## Notification Broadcasting

Cron tasks can broadcast to multiple channels:

1. Channels opt-in via `receiveNotifications: true` in `~/.betterclaw/channels.yaml`
2. Cron task's `send_message` tool calls broadcast to ALL notification channels
3. Final task result (if `notifyUser: true`) is also broadcast

## External Integrations

- **Telegram Bot API**: Primary user interaction platform
- **Discord Bot API**: Secondary user interaction platform
- **SearXNG**: Local Docker-based search engine for web research
- **Crawl4AI**: Web crawling service (Docker-based)
- **LLM Providers**: OpenRouter/OpenAI for reasoning and tool calling

## Configuration & Persistence

The application stores its state in `~/.betterclaw/`:

| Path | Purpose |
|------|---------|
| `config.yaml` | Main user configuration (AI, tokens, services) |
| `channels.yaml` | Channel permissions and notification settings |
| `knowledge/lancedb/` | Vector database for RAG |
| `jobs/` | Job and node definitions (JSON) |
| `cron/tasks/` | Scheduled task definitions (JSON) |
| `prompts/` | Editable Markdown templates for agent personas |
| `skills/state/` | Skill setup completion state |
| `logs/` | Application logs |
| `workspace/` | Working directory for file operations |
| `databases/` | SQLite databases for structured data |
| `rss-state/` | RSS feed last-read state |
