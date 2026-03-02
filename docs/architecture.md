# BetterClaw Architecture

BetterClaw is a proactive AI assistant daemon for Linux, designed to run as a long-lived Node.js process. It operates autonomously to manage personal tasks, knowledge, and scheduled jobs, interacting through Telegram, Discord, and a dedicated Angular-based web UI.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js (>= 22) |
| Language | TypeScript |
| Package Manager | `pnpm` (Workspace/Monorepo) |
| AI/LLM | Vercel AI SDK (`ai`), OpenRouter, OpenAI, LM Studio |
| Embeddings | Configurable local (GTE multilingual) or OpenRouter |
| Databases | LanceDB (Vector), SQLite (`better-sqlite3`) |
| Messaging | Telegram (`grammy`), Discord (`discord.js`), WebSockets (`socket.io`) |
| Task Scheduling | `node-cron` |
| Frontend | Angular (located in `brain-interface/`) |

## Initialization Sequence

```
┌─────────────────────────────────────────────────────────────────┐
│                     INITIALIZATION SEQUENCE                      │
├─────────────────────────────────────────────────────────────────┤
│  1. ConfigService      → Load ~/.betterclaw/config.yaml         │
│  2. LoggerService      → Initialize logging                      │
│  3. PromptService      → Load agent prompts                      │
│  4. AiProviderService  → Initialize LLM connections              │
│  5. EmbeddingService   → Load embedding model                    │
│  6. VectorStoreService → Connect to LanceDB                      │
│  7. SkillLoaderService → Discover and load skills                │
│  8. ChannelRegistry    → Register channels from config           │
│  9. MessagingService   → Platform adapters (Telegram, etc.)      │
│  10. SchedulerService  → Start cron task scheduler               │
│  11. BrainInterface    → WebSocket server for Angular UI         │
└─────────────────────────────────────────────────────────────────┘
```

Graceful shutdown handlers are registered for `SIGTERM` and `SIGINT` signals.

## Directory Structure

```
src/
├── agent/              # AI agent logic (MainAgent, CronAgent, BaseAgentBase)
├── defaults/prompts/   # Factory default prompt templates
├── executors/          # Task executors (cron, jobs)
├── helpers/            # Stateless utility modules (tool-registry, knowledge, etc.)
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
├── utils/              # ID generation, path helpers, token counting
└── index.ts            # Entry point

brain-interface/        # Angular web application
tests/
├── unit/               # Pure unit tests
├── integration/
│   ├── core/           # Core integration tests
│   └── jobs/           # Job-related integration tests
└── utils/              # Shared test utilities
```

## Service Categories

### Singletons (Stateful Services)

Services in `src/services/` that manage shared state:

| Service | Responsibility |
| :--- | :--- |
| **AiProviderService** | LLM model instances, rate limiter |
| **VectorStoreService** | LanceDB connection |
| **EmbeddingService** | Loaded ML model |
| **SchedulerService** | Active timers, cron scheduling |
| **LoggerService** | File streams |
| **ConfigService** | Parsed config cache |
| **ChannelRegistryService** | Channel permissions and notifications |
| **JobStorageService** | Job and node definitions |
| **JobExecutorService** | Running job execution |
| **SkillLoaderService** | Loaded skills |
| **MessagingService** | Platform adapters |
| **RateLimiterService** | API rate limit state |
| **PromptService** | Agent prompt templates |
| **StatusService** | Token counting, status state |
| **ModelInfoService** | OpenRouter/LM Studio model info |
| **CronMessageHistoryService** | Cron task message history |

### Helpers (Stateless Utilities)

Modules in `src/helpers/` with no shared state:

| Helper | Purpose |
| :--- | :--- |
| **tool-registry** | Tool permission filtering |
| **dependency-checker** | Binary/env requirement checking |
| **rss-state** | RSS feed seen-ID tracking |
| **skill-state** | Skill setup state persistence |
| **skill-installer** | Skill dependency installation |
| **litesql** | SQLite database operations |
| **knowledge** | Vector store document operations |
| **litesql-validation** | Database/table existence validation |

## Platform Adapter Pattern

Platforms (Telegram, Discord, BrainInterface) integrate via the `IPlatformAdapter` interface:

```typescript
interface IPlatformAdapter {
  platform: string;                    // "telegram" | "discord" | "brain-interface"
  startAsync(): Promise<void>;         // Start listening for messages
  stopAsync(): Promise<void>;          // Graceful shutdown
  sendAsync(chatId: string, message: string): Promise<void>;
}
```

Platform initialization receives dependencies via `IPlatformDeps`:

```typescript
interface IPlatformDeps {
  mainAgent: MainAgent;               // Message processor
  channelRegistry: ChannelRegistryService;
  messagingService: MessagingService;
  toolRegistry: typeof ToolRegistry;  // Helper module
  logger: LoggerService;
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
4. **Orchestration**: `MainAgent` receives the input, retrieves relevant context from knowledge helpers, and decides on actions.
5. **Execution**: The agent calls one or more `tools` (e.g., `run_cmd`, `add_knowledge`, `execute_job`).
6. **Automation**: `SchedulerService` triggers `CronAgent` for background tasks, which may execute `Jobs` or `Skills`.
7. **Output**: The agent sends a response back to the originating platform via `MessagingService`.

## Token Management

The agent proactively manages context window usage:

- **Token Counting**: Uses tiktoken (cl100k_base) for accurate counting
- **Compaction**: Triggers at 75% of context window
- **Reactive Compaction**: On 400 "context exceeded" errors, compacts and retries
- **API-Level Logging**: INFO-level logs show token breakdown per request

## Notification Broadcasting

Cron tasks can broadcast to multiple channels:

1. Channels opt-in via `receiveNotifications: true` in `~/.betterclaw/channels.yaml`
2. Cron task's `send_message` tool calls broadcast to ALL notification channels
3. Final task result (if `notifyUser: true`) is also broadcast

## External Integrations

| Integration | Purpose |
|-------------|---------|
| Telegram Bot API | Primary user interaction platform |
| Discord Bot API | Secondary user interaction platform |
| SearXNG | Local Docker-based search engine for web research |
| Crawl4AI | Web crawling service (Docker-based) |
| LM Studio | Local LLM server (OpenAI-compatible API) |
| LLM Providers | OpenRouter/OpenAI for reasoning and tool calling |

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
| `skills/` | Installed skill directories |
| `skills/state/` | Skill setup completion state |
| `logs/` | Application logs |
| `workspace/` | Working directory for file operations |
| `databases/` | SQLite databases for structured data |
| `rss-state/` | RSS feed last-read state |
