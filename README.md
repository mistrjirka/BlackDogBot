# BetterClaw

A proactive AI assistant daemon for Linux. It runs as a long-lived process, communicates via Telegram, and executes structured jobs, skills, and scheduled tasks autonomously.

## Features

- **Jobs** — Directed acyclic graphs of typed nodes with Zod-validated I/O schemas. 7 node types: `manual`, `python_code`, `curl_fetcher`, `crawl4ai`, `searxng`, `output_to_ai`, `agent`.
- **Skills** — Pluggable capabilities described in `SKILL.md` files (OpenClaw-compatible format). Skills go through a setup phase and are then callable by the agent.
- **Scheduled Tasks** — Cron-like periodic tasks with `cron`, `interval`, and `once` schedule types, executed by a dedicated cron agent.
- **Knowledge** — Persistent vector database (LanceDB + BGE-M3 embeddings) for storing and retrieving information across sessions.
- **Telegram** — Primary messaging interface with `/start`, `/reset` commands.
- **Externalized Prompts** — All agent prompts live in `~/.betterclaw/prompts/` and can be modified at runtime via tools or reset to factory defaults.

## Requirements

- Node.js >= 22
- pnpm
- Docker & Docker Compose (for SearXNG and Crawl4AI services)

## Quick Start

### Option A: Interactive Install (Recommended)

Run the interactive install script:

```bash
./install.sh
```

This will:
1. Check and install dependencies (Node.js, pnpm)
2. Prompt for AI provider configuration
3. Optionally set up Docker services (SearXNG, Crawl4AI)
4. Create the config file with all required settings
5. Create required directories
6. Copy default prompts

### Option B: Manual Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start Docker services (optional)

SearXNG (web search) and Crawl4AI (web crawling) can run as Docker containers. Create `~/.betterclaw/docker-compose.yaml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "18731:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:18731/
      - SEARXNG_SECRET=<generate-with-openssl-rand-hex-32>
    volumes:
      - searxng-data:/etc/searxng
    restart: unless-stopped

  crawl4ai:
    image: unclecode/crawl4ai:latest
    ports:
      - "18732:8000"
    restart: unless-stopped

volumes:
  searxng-data:
```

Then start:

```bash
docker compose -f ~/.betterclaw/docker-compose.yaml up -d
```

This starts:
- SearXNG on port `18731`
- Crawl4AI on port `18732`

### 3. Create config

Create `~/.betterclaw/config.yaml`:

```yaml
ai:
  provider: openrouter
  openrouter:
    apiKey: sk-or-your-key
    model: anthropic/claude-sonnet-4
    rateLimits:
      rpm: 60
      tpm: 100000

telegram:
  botToken: "your-telegram-bot-token"

scheduler:
  enabled: true
  notificationChatId: null  # Telegram chat ID for cron notifications

knowledge:
  embeddingModelPath: Xenova/bge-m3
  lancedbPath: ~/.betterclaw/knowledge/lancedb

skills:
  directories: []

logging:
  level: info

services:
  searxngUrl: http://localhost:18731
  crawl4aiUrl: http://localhost:18732
```

You can also use an OpenAI-compatible provider (e.g. Ollama):

```yaml
ai:
  provider: openai-compatible
  openaiCompatible:
    baseUrl: http://localhost:11434/v1
    apiKey: your-key
    model: llama3
```

### 4. Start the daemon

```bash
pnpm start
```

Or in watch mode for development:

```bash
pnpm dev
```

## Architecture

```
src/
├── agent/              # Main agent, cron agent, base agent class
├── defaults/prompts/   # Factory default prompt templates
├── jobs/               # Graph validation, schema compatibility
├── services/           # 14 singleton services
├── shared/             # Types, schemas, constants
├── skills/             # Skill parser, setup runner
├── telegram/           # Bot adapter, message handler
├── tools/              # 27 agent tools
├── utils/              # ID generation, path helpers
└── index.ts            # Entry point
```

### Services

| Service | Purpose |
|---|---|
| `ConfigService` | Loads and validates `~/.betterclaw/config.yaml` |
| `LoggerService` | Structured logging with configurable levels |
| `AiProviderService` | Creates LLM model instances (OpenRouter / OpenAI-compatible) |
| `RateLimiterService` | Per-provider TPM/RPM rate limiting via Bottleneck |
| `PromptService` | Loads, caches, and resolves prompt templates with `{{include:}}` directives |
| `EmbeddingService` | Local BGE-M3 embeddings via Transformers.js (1024-dim vectors) |
| `VectorStoreService` | LanceDB vector storage with cosine similarity search |
| `KnowledgeService` | High-level knowledge CRUD over the vector store |
| `JobStorageService` | Persists jobs, nodes, and test cases to `~/.betterclaw/jobs/` |
| `JobExecutorService` | Executes job graphs in topological order with I/O validation |
| `SkillLoaderService` | Discovers and loads skills from configured directories |
| `SkillStateService` | Persists skill setup state |
| `SchedulerService` | Manages cron/interval/once scheduled tasks |
| `MessagingService` | Platform-agnostic messaging adapter registry |

### Agent Tools (27)

**Core:** `think`, `done`, `run_cmd`, `send_message`

**Prompts:** `modify_prompt`, `list_prompts`

**Knowledge:** `search_knowledge`, `add_knowledge`, `edit_knowledge`

**Jobs:** `add_job`, `edit_job`, `remove_job`, `get_jobs`, `run_job`, `finish_job`

**Nodes:** `add_node`, `edit_node`, `remove_node`, `connect_nodes`, `set_entrypoint`, `add_node_test`, `run_node_test`

**Skills:** `call_skill`, `get_skill_file`

**Cron:** `add_cron`, `remove_cron`, `list_crons`

### Node Types

| Type | Description |
|---|---|
| `manual` | Passthrough — returns input unchanged |
| `python_code` | Executes Python code in a temp file, I/O via base64 env var |
| `curl_fetcher` | HTTP requests with template URL/body substitution |
| `crawl4ai` | Web page crawling with optional AI extraction |
| `searxng` | Web search via local SearXNG instance |
| `output_to_ai` | Sends data to an LLM with a custom prompt |
| `agent` | Spawns a sub-agent with selected tools from a pool |

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/reset <prompt-name>` | Reset a specific prompt to factory default |
| `/reset all` | Reset all prompts to factory defaults |

Any other message is forwarded to the main agent for processing.

## Testing

```bash
# Run all tests (uses real services — no mocking of AI or external services)
pnpm test:integration

# Typecheck
pnpm typecheck
```

> **Important:** Never pipe test output through `head`, `tail -N`, or any other
> truncation command. Test failures are printed at the end of the output; truncating
> will silently hide them. If output is large, redirect to a file instead:
> ```bash
> pnpm vitest run --config vitest.integration.config.ts --reporter=verbose 2>&1 > /tmp/test-output.txt
> ```

### LLM mocking policy

Tests that exercise actual AI behaviour use **real LLM calls** — no mocking of `generateText` or the `ai` package itself.
Tests for pure non-LLM logic (routing, session management, error handling) may mock at the agent/service level.

### Test Suite (28 files, 162 tests)

| File | Tests | What it covers |
|---|---|---|
| `graph.test.ts` | 10 | DAG validation, cycle detection, topological sort, unreachable nodes |
| `schema-compat.test.ts` | 11 | JSON Schema compatibility checks, data validation, compile-error path, missing-type branches |
| `config-service.test.ts` | 5 | YAML config loading, missing file errors, optional sections |
| `config-service-extended.test.ts` | 8 | Uninitialized error, all getter methods, saveConfigAsync, updateConfigAsync |
| `prompt-service.test.ts` | 7 | Prompt CRUD, include directive resolution, factory reset |
| `scheduler.test.ts` | 5 | Task persistence, retrieval, removal, disk reload, enabled filtering |
| `scheduler-extended.test.ts` | 8 | Interval/once/cron scheduling, past-time skip, executor callback, failure/success status, stopAsync, disabled on startup |
| `embedding-service.test.ts` | 2 | BGE-M3 model loading, 1024-dim output, semantic similarity |
| `ai-provider-e2e.test.ts` | 3 | Model creation, real LLM calls via OpenRouter |
| `ai-provider-unit.test.ts` | 11 | openrouter/openai-compatible init, getRateLimiter, error paths, unsupported provider |
| `knowledge-e2e.test.ts` | 4 | Document add/search/edit, multi-document relevance ranking |
| `knowledge-extended.test.ts` | 3 | deleteDocumentAsync, getDocumentCountAsync, empty collection count |
| `main-agent-e2e.test.ts` | 2 | Message processing, think tool usage (real LLM) |
| `main-agent-unit.test.ts` | 4 | Session management, clearChatHistory, duplicate session guard, uninitialized guard |
| `cron-agent-e2e.test.ts` | 2 | Task execution with think and send_message tools (real LLM) |
| `job-execution-e2e.test.ts` | 15 | All 7 node types, pipelines, schema validation failures |
| `ai-job-creation-e2e.test.ts` | 1 | Natural language job creation via main agent (real LLM) |
| `llm-retry-e2e.test.ts` | 2 | generateTextWithRetryAsync happy path with real LLM, system prompt forwarding |
| `telegram-handler.test.ts` | 7 | Message routing, concurrent dedup guard, agent error → error reply, failed reply logging |
| `telegram-e2e.test.ts` | 1 | Message handling with mocked grammY context |
| `skill-parser.test.ts` | 5 | parseSkillFileAsync: valid parse, defaults, invalid name, missing name, file not found |
| `skill-state.test.ts` | 5 | SkillStateService: default state, roundtrip, markSetupComplete, markSetupError, overwrite |
| `skill-loader.test.ts` | 9 | SkillLoaderService: load from dirs, getAllSkills, getAvailableSkills, missing dir, skip invalid |
| `setup-runner-e2e.test.ts` | 2 | runSkillSetupAsync: success with no requirements, success with openclaw metadata (real LLM) |
| `messaging.test.ts` | 6 | MessagingService: register, send, no adapter error, multi-platform, sender. TelegramAdapter: platform, sendMessage |
| `base-agent.test.ts` | 4 | BaseAgentBase: uninitialized throw, init flag, default options, custom options |
| `base-agent-e2e.test.ts` | 2 | BaseAgentBase: processMessage with real LLM, stepsCount verification (real LLM) |
| `paths.test.ts` | 14 | All path functions, ensureDirectoryExistsAsync, ensureAllDirectoriesAsync |

## Data Storage

All persistent data is stored under `~/.betterclaw/`:

```
~/.betterclaw/
├── config.yaml          # Main configuration
├── prompts/             # Agent prompt templates (editable)
├── jobs/                # Job and node definitions (JSON)
├── knowledge/
│   └── lancedb/         # Vector database files
├── skills/
│   └── state/           # Skill setup state
└── cron/
    └── tasks/           # Scheduled task definitions (JSON)
```

## License

GPL-2.0
