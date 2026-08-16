# BlackDogBot Architecture

BlackDogBot is a proactive AI assistant daemon for Linux, designed to run as a long-lived Node.js process. It operates autonomously to manage personal tasks, knowledge, and scheduled tasks, interacting through Telegram, Discord, and a dedicated Angular-based web UI.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js (>= 22, including Node.js 26) |
| Language | TypeScript |
| Package Manager | `pnpm` (Workspace/Monorepo) |
| AI/LLM | Vercel AI SDK (`ai`), OpenRouter, OpenAI, LM Studio |
| Embeddings | Configurable local (GTE multilingual) or OpenRouter |
| Databases | LanceDB (Vector), SQLite (`better-sqlite3`) |
| Messaging | Telegram (`grammy`), Discord (`discord.js`), WebSockets (`socket.io`) |
| Task Scheduling | Built-in `SchedulerService` using timers (interval and once) |
| Frontend | Angular (located in `brain-interface/`) |

## Initialization Sequence

```
┌─────────────────────────────────────────────────────────────────┐
│                     INITIALIZATION SEQUENCE                      │
├─────────────────────────────────────────────────────────────────┤
│  1. ConfigService      → Load ~/.blackdogbot/config.yaml         │
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

The daemon starts through `scripts/launch.sh`, which prepares CUDA library paths, verifies native runtime dependencies, and invokes the project-local `tsx` binary. It can be run directly with `pnpm start` or under a user-level systemd service installed by `scripts/install-user-service.sh`.

## Directory Structure

```
src/
├── agent/              # AI agent logic (MainAgent, CronAgent, BaseAgentBase)
├── defaults/prompts/   # Factory default prompt templates
├── executors/          # Scheduled task executors
├── helpers/            # Stateless utility modules (tool-registry, knowledge, etc.)
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
└── utils/              # Shared test utilities
```

## Service Categories

### Singletons (Stateful Services)

Services in `src/services/` that manage shared state:

| Service | Responsibility |
| :--- | :--- |
| **AiProviderService** | LLM model instances and providers |
| **ChannelRegistryService** | Channel permissions and notifications |
| **CommandDetectorLinuxService** | Linux command detection |
| **CommandProcessService** | Command process lifecycle |
| **ConfigService** | Parsed config cache |
| **CronMessageHistoryService** | Scheduled task message history |
| **EmbeddingService** | Loaded embedding model |
| **FactoryResetService** | Application data reset |
| **LoggerService** | File streams |
| **McpRegistryService** | MCP server registry |
| **McpService** | MCP server integration |
| **MessagingService** | Platform adapters |
| **ModelInfoService** | Provider model information |
| **ModelProfileService** | Model profile configuration |
| **PromptService** | Agent prompt templates |
| **RateLimiterService** | API rate limit state |
| **SchedulerService** | Active timers and scheduled tasks |
| **SkillLoaderService** | Loaded skills |
| **StatusService** | Token counting and status state |
| **TelegramOutboxService** | Telegram message delivery queue |
| **ToolHotReloadService** | Tool hot-reload lifecycle |
| **VectorStoreService** | LanceDB connection |

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
5. **Execution**: The agent calls one or more `tools` (e.g., `run_cmd`, `add_knowledge`, `send_message`).
6. **Automation**: `SchedulerService` triggers `CronAgent` for background tasks, which may execute scheduled tasks or skills.
7. **Output**: The agent sends a response back to the originating platform via `MessagingService`.

## Token Management

The agent proactively manages context window usage:

- **Token Counting**: Uses tiktoken (cl100k_base) for accurate counting
- **Compaction**: Triggers at 70% of context window
- **Reactive Compaction**: On 400 "context exceeded" errors, compacts and retries
- **API-Level Logging**: INFO-level logs show token breakdown per request

## Notification Broadcasting

Cron tasks can broadcast to multiple channels:

1. Channels opt-in via `receiveNotifications: true` in `~/.blackdogbot/channels.yaml`
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

The application stores its state in `~/.blackdogbot/`:

| Path | Purpose |
|------|---------|
| `config.yaml` | Main user configuration (AI, tokens, services) |
| `channels.yaml` | Channel permissions and notification settings |
| `knowledge/lancedb/` | Vector database for RAG |
| `cron/tasks/` | Scheduled task definitions (JSON) |
| `prompts/` | Editable Markdown templates for agent personas |
| `skills/` | Installed skill directories |
| `skills/<name>/state.json` and `skill-state/<hash>.json` | Managed and scoped skill setup state |
| `logs/` | Application logs |
| `workspace/` | Working directory for file operations |
| `databases/` | SQLite databases for structured data |
| `rss-state/` | RSS feed last-read state |
