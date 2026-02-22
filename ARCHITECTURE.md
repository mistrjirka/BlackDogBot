# BetterClaw Architecture

BetterClaw is a proactive AI assistant daemon for Linux, designed to run as a long-lived Node.js process. It operates autonomously to manage personal tasks, knowledge, and scheduled jobs, interacting primarily through Telegram and a dedicated Angular-based web UI.

## Tech Stack
- **Runtime**: Node.js (>= 22)
- **Language**: TypeScript
- **Package Manager**: `pnpm` (Workspace/Monorepo)
- **AI/LLM**: Vercel AI SDK (`ai`), OpenRouter, OpenAI
- **Embeddings**: Local BGE-M3 via Transformers.js
- **Databases**: LanceDB (Vector), SQLite (`better-sqlite3`)
- **Messaging**: Telegram (`grammy`), WebSockets (`socket.io`)
- **Task Scheduling**: `node-cron`
- **Frontend**: Angular (located in `brain-interface/`)

## Directory Structure
- `src/`: Core daemon application source code.
  - `agent/`: AI agent logic (MainAgent, CronAgent).
  - `services/`: Singleton services managing state and logic.
  - `tools/`: Pluggable agent tool definitions (CRUD, Knowledge, Jobs).
  - `jobs/`: DAG-based job validation and execution logic.
  - `skills/`: Pluggable capability definitions (`SKILL.md` parser).
  - `telegram/`: Telegram bot integration and message routing.
  - `shared/`: Shared types, constants, and Zod schemas.
  - `brain-interface/`: WebSocket server for the Angular UI.
- `brain-interface/`: Independent Angular web application.
- `tests/integration/`: Integration tests using Vitest (running against real services).
- `searxng/`: Docker configuration for the local search engine.
- `~/.betterclaw/`: Runtime data directory (Config, DBs, Prompts).

## Core Components
BetterClaw is built around several decoupled singleton services:

| Service | Responsibility |
| :--- | :--- |
| **AiProviderService** | Manages LLM connections across providers (OpenRouter, OpenAI). |
| **KnowledgeService** | Interface for the LanceDB vector store for RAG and memory. |
| **JobExecutorService** | Executes Directed Acyclic Graphs (DAG) of automated job nodes. |
| **SchedulerService** | Orchestrates cron, interval, and one-off scheduled tasks. |
| **SkillLoaderService** | Dynamically discovers and loads pluggable skills from the filesystem. |
| **ConfigService** | Loads and validates configuration from `~/.betterclaw/config.yaml`. |
| **MessagingService** | Platform-agnostic messaging registry (Telegram, BrainInterface). |

## Data Flow
1. **Input**: A message arrives via Telegram (`grammy`) or WebSocket (`brain-interface`).
2. **Orchestration**: `MainAgent` receives the input, retrieves relevant context from `KnowledgeService`, and decides on actions.
3. **Execution**: The agent calls one or more `tools` (e.g., `run_cmd`, `add_knowledge`, `execute_job`).
4. **Automation**: `SchedulerService` triggers `CronAgent` for background tasks, which may execute `Jobs` or `Skills`.
5. **Output**: The agent sends a response back to the originating platform via `MessagingService`.

## External Integrations
- **Telegram Bot API**: For user interaction.
- **SearXNG**: Local Docker-based search engine for web research.
- **Crawl4AI**: Web crawling service (Docker-based).
- **LLM Providers**: OpenRouter/OpenAI for reasoning and tool calling.

## Configuration & Persistence
The application stores its state in `~/.betterclaw/`:
- `config.yaml`: Main user configuration.
- `knowledge/lancedb/`: Local vector database.
- `jobs/` & `cron/tasks/`: JSON definitions for automation.
- `prompts/`: Editable Markdown templates for agent personas.
