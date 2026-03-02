# BetterClaw Architecture

BetterClaw is a proactive AI assistant daemon for Linux, designed to run as a long-lived Node.js process. It operates autonomously to manage personal tasks, knowledge, and scheduled jobs, interacting primarily through Telegram and a dedicated Angular-based web UI.

## Tech Stack
- **Runtime**: Node.js (>= 22)
- **Language**: TypeScript
- **Package Manager**: `pnpm` (Workspace/Monorepo)
- **AI/LLM**: Vercel AI SDK (`ai`), OpenRouter, OpenAI, LM Studio
- **Embeddings**: Configurable local (GTE multilingual) or OpenRouter embeddings
- **Databases**: LanceDB (Vector), SQLite (`better-sqlite3`)
- **Messaging**: Telegram (`grammy`), WebSockets (`socket.io`)
- **Task Scheduling**: `node-cron`
- **Frontend**: Angular (located in `brain-interface/`)

## Entrypoint & Initialization

The application entrypoint is `src/index.ts`. Initialization follows a phased approach:

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
- `src/`: Core daemon application source code.
  - `agent/`: AI agent logic (MainAgent, CronAgent, BaseAgentBase).
  - `services/`: Singleton services with shared state.
  - `helpers/`: Stateless utility modules (no class wrapper).
  - `tools/`: Pluggable agent tool definitions (CRUD, Knowledge, Jobs).
  - `jobs/`: DAG-based job validation and execution logic.
  - `skills/`: Pluggable capability definitions (`SKILL.md` parser).
  - `utils/`: Shared utilities (token counting, error handling, etc.).
  - `shared/`: Shared types, constants, and Zod schemas.
  - `brain-interface/`: WebSocket server for the Angular UI.
- `brain-interface/`: Independent Angular web application.
- `tests/`: Unit and integration tests using Vitest.
- `~/.betterclaw/`: Runtime data directory (Config, DBs, Prompts).

## Service Categories

### Singletons (Stateful Services)
Services in `src/services/` that manage shared state:

| Service | State Managed |
| :--- | :--- |
| **AiProviderService** | LLM model instances, rate limiter |
| **VectorStoreService** | LanceDB connection |
| **EmbeddingService** | Loaded ML model |
| **SchedulerService** | Active timers |
| **LoggerService** | File streams |
| **ConfigService** | Parsed config cache |
| **ChannelRegistryService** | Channel permissions |
| **JobStorageService** | Job definitions |
| **JobExecutorService** | Running jobs |
| **SkillLoaderService** | Loaded skills |
| **MessagingService** | Platform adapters |
| **RateLimiterService** | Rate limit state |

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

## Data Flow
1. **Input**: A message arrives via Telegram (`grammy`) or WebSocket (`brain-interface`).
2. **Orchestration**: `MainAgent` receives the input, retrieves relevant context from knowledge helpers, and decides on actions.
3. **Execution**: The agent calls one or more `tools` (e.g., `run_cmd`, `add_knowledge`, `execute_job`).
4. **Automation**: `SchedulerService` triggers `CronAgent` for background tasks, which may execute `Jobs` or `Skills`.
5. **Output**: The agent sends a response back to the originating platform via `MessagingService`.

## Token Management

The agent proactively manages context window usage:

- **Token Counting**: Uses tiktoken (cl100k_base) for accurate counting
- **Compaction**: Triggers at 75% of context window
- **Reactive Compaction**: On 400 "context exceeded" errors, compacts and retries
- **API-Level Logging**: INFO-level logs show token breakdown per request

## External Integrations
- **Telegram Bot API**: For user interaction.
- **SearXNG**: Local Docker-based search engine for web research.
- **Crawl4AI**: Web crawling service (Docker-based).
- **LM Studio**: Local LLM server (OpenAI-compatible API).
- **LLM Providers**: OpenRouter/OpenAI for reasoning and tool calling.

## Configuration & Persistence
The application stores its state in `~/.betterclaw/`:
- `config.yaml`: Main user configuration.
- `knowledge/lancedb/`: Local vector database.
- `jobs/` & `cron/tasks/`: JSON definitions for automation.
- `prompts/`: Editable Markdown templates for agent personas.
- `skills/`: Installed skill directories.
- `databases/`: SQLite databases created by the agent.
