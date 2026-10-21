# BlackDogBot Configuration Guide

## Main Config File

Primary configuration path:

- `~/.blackdogbot/config.yaml`

## AI Providers

### OpenRouter

```yaml
ai:
  provider: openrouter
  generationTimeoutMs: 600000  # 10 min floor for all generation paths (default: 600000, min: 600000)
  openrouter:
    apiKey: sk-or-v1-xxx
    model: anthropic/claude-sonnet-4
    rateLimits:
      rpm: 60
      tpm: 100000
```

### OpenAI-Compatible

```yaml
ai:
  provider: openai-compatible
  generationTimeoutMs: 600000  # 10 min floor, min 600000
  openaiCompatible:
    baseUrl: http://localhost:11434/v1
    apiKey: ollama
    model: llama3
    contextWindow: 8192
    rateLimits:
      rpm: 120
      tpm: 200000
```

### LM Studio

```yaml
ai:
  provider: lm-studio
  generationTimeoutMs: 600000  # 10 min floor, min 600000
  lmStudio:
    baseUrl: http://localhost:1234/v1
    apiKey: lm-studio
    model: models/YourModelName
    contextWindow: 8192
    rateLimits:
      rpm: 120
      tpm: 200000
```

## Context Compaction

Compaction is controlled by a single number: the fraction of the model context window that triggers a checkpoint summary. The default is `0.90` (90%).

```yaml
ai:
  provider: openai-compatible
  compactionThreshold: 0.90        # 50%-94%; single trigger knob
  disableThinkingOnStructuredOutput: true  # llama.cpp: enable_thinking=false for JSON schema calls
```

At the trigger, the agent keeps the current tool call and its result, summarizes the older prefix with the same system prompt and tool set (so the provider can reuse the prompt cache), and continues from the summary plus the preserved tool state. If the summary call fails, the run errors out rather than silently truncating history.

## Tool Output Limits

These are environment-configurable and are also surfaced in the tool descriptions/system context:

```bash
BLACKDOGBOT_CAPTURE_THRESHOLD_CHARS=4000        # larger results become stored variables
BLACKDOGBOT_PREVIEW_MAX_CHARS=1200              # stub preview size
BLACKDOGBOT_INSPECT_VARIABLE_MAX_CHARS=24000    # max chars per inspect_variable call
BLACKDOGBOT_INSPECT_VARIABLE_DEFAULT_CHARS=4000 # default inspect_variable slice
BLACKDOGBOT_READ_DB_DEFAULT_LIMIT=20            # default read_from_database rows (max 50)
BLACKDOGBOT_MAIN_AGENT_MAX_STEPS=300
BLACKDOGBOT_CRON_AGENT_MAX_STEPS=300
```

## Messaging Platforms

### Telegram

```yaml
telegram:
  botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
  allowedUsers: ["123456789"]
```

### Discord

```yaml
discord:
  botToken: "MTk4NjIyNDgzNDc..."
  allowedGuilds: ["123456789"]
```

## Embeddings

### Local embeddings

```yaml
knowledge:
  embeddingProvider: local
  embeddingModelPath: onnx-community/Qwen3-Embedding-0.6B-ONNX
  embeddingDevice: auto
  embeddingDtype: q8
```

### OpenRouter embeddings

```yaml
knowledge:
  embeddingProvider: openrouter
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
```

## Scheduler

```yaml
scheduler:
  enabled: true
  timezone: Europe/Prague
```

## Skills

```yaml
skills:
  directories:
    - ~/.blackdogbot/skills
  autoSetup: true
  autoSetupNotify: true
  installTimeout: 300000
  allowedInstallKinds:
    - brew
    - node
    - go
    - uv
  skipOsCheck: false
```

## Logging

```yaml
logging:
  level: info
```

## Optional Services

SearXNG is configured in `config.yaml`:

```yaml
services:
  searxngUrl: http://localhost:18731
```

Crawl4AI is configured as a remote MCP server in `~/.blackdogbot/mcp-servers.json`, not as a `services.crawl4aiUrl` entry. The standard local entry uses `url: "http://127.0.0.1:18732/mcp/sse"`, `transport: "sse"`, `strictOutputSchema: false`, and an `Authorization: Bearer <token>` header. Keep both the token environment file and `mcp-servers.json` private (`chmod 600`). If `allowedTools` is omitted, all tools discovered from the MCP server are exposed subject to channel permissions.

## Data Paths

Persistent runtime data lives in `~/.blackdogbot/`:

```text
~/.blackdogbot/
|- config.yaml
|- channels.yaml
|- mcp-servers.json
|- known-telegram-chats.json
|- brain-interface.token
 |- prompts/
 |  \- prompt-fragments/
 |- cron/
 |- knowledge/lancedb/
 |- skills/
 |- logs/
|- workspace/
|- databases/
|- rss-state/
|- model-profiles/
|- sessions/
\- models/
```
