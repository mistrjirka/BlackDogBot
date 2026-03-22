# BlackDogBot Configuration Guide

## Main Config File

Primary configuration path:

- `~/.blackdogbot/config.yaml`

## AI Providers

### OpenRouter

```yaml
ai:
  provider: openrouter
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
  lmStudio:
    baseUrl: http://localhost:1234/v1
    apiKey: lm-studio
    model: models/YourModelName
    contextWindow: 8192
    rateLimits:
      rpm: 120
      tpm: 200000
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

## Job Creation

```yaml
jobCreation:
  enabled: true
  requirePassingNodeTests: true
  requireSuccessfulRunBeforeFinish: true
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

```yaml
services:
  searxngUrl: http://localhost:18731
  crawl4aiUrl: http://localhost:18732
```

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
|- jobs/
|- cron/
|- knowledge/lancedb/
|- skills/
|- logs/
|  \- jobs/
|- workspace/
|- databases/
|- rss-state/
|- model-profiles/
|- sessions/
\- models/
```
