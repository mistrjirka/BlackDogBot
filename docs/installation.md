# BetterClaw Installation Guide

## Requirements

- Node.js >= 22
- pnpm
- Docker & Docker Compose (optional, for SearXNG and Crawl4AI services)

## Quick Install

Run the interactive install script:

```bash
./install.sh
```

The script will:
1. Check and install dependencies (Node.js, pnpm)
2. Prompt for AI provider configuration
3. Prompt for Telegram and/or Discord bot tokens
4. Optionally set up Docker services (SearXNG, Crawl4AI)
5. Create the config file with all required settings
6. Create required directories
7. Copy default prompts

## Manual Installation

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Create Configuration

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

discord:
  botToken: "your-discord-bot-token"

scheduler:
  enabled: true

jobCreation:
  enabled: true

knowledge:
  embeddingProvider: local
  embeddingModelPath: onnx-community/Qwen3-Embedding-0.6B-ONNX
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
  lancedbPath: ~/.betterclaw/knowledge/lancedb

skills:
  directories: []

logging:
  level: info

services:
  searxngUrl: http://localhost:18731
  crawl4aiUrl: http://localhost:18732
```

### 3. Set Up Docker Services (Optional)

Create `~/.betterclaw/docker-compose.yaml`:

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

Start services:

```bash
docker compose -f ~/.betterclaw/docker-compose.yaml up -d
```

### 4. Create Required Directories

```bash
mkdir -p ~/.betterclaw/{prompts,jobs,cron/tasks,knowledge/lancedb,skills/state,logs,workspace,databases,rss-state}
```

### 5. Start the Daemon

```bash
pnpm start
```

Or in watch mode for development:

```bash
pnpm dev
```

## Post-Installation

### Enable Notifications

After starting, enable notifications for your channel:

**Telegram:**
```
/notifications_enable
```

**Discord:**
Send any message to register the channel, then manually edit `~/.betterclaw/channels.yaml` to set `receiveNotifications: true`.

### Verify Installation

Check the logs:

```bash
tail -f ~/.betterclaw/logs/betterclaw.log
```

## Configuration Reference

### AI Providers

**OpenRouter (recommended):**
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

**OpenAI-compatible (Ollama, etc.):**
```yaml
ai:
  provider: openai-compatible
  openaiCompatible:
    baseUrl: http://localhost:11434/v1
    apiKey: ollama
    model: llama3
```

### Messaging Platforms

**Telegram:**
```yaml
telegram:
  botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
  allowedUsers: ["123456789"]  # Optional: restrict to specific users
```

**Discord:**
```yaml
discord:
  botToken: "MTk4NjIyNDgzNDc..."
  allowedGuilds: ["123456789"]  # Optional: restrict to specific servers
```

### Embeddings

**Local (default):**
```yaml
knowledge:
  embeddingProvider: local
  embeddingModelPath: onnx-community/Qwen3-Embedding-0.6B-ONNX
```

**OpenRouter:**
```yaml
knowledge:
  embeddingProvider: openrouter
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
```

## Troubleshooting

### Bot Not Responding

1. Check if the bot token is correct
2. Verify the bot is running: `pnpm start`
3. Check logs for errors: `tail -f ~/.betterclaw/logs/betterclaw.log`

### Discord Bot Requires Privileged Intents

Enable these in the Discord Developer Portal:
- Message Content Intent
- Server Members Intent (if needed)

### Embedding Model Download Fails

The first run downloads the embedding model (~600MB). If it fails:
1. Check internet connection
2. Try clearing the cache: `rm -rf ~/.cache/huggingface/`
3. Run again

### Cron Tasks Not Sending Notifications

1. Ensure channels have `receiveNotifications: true` in `~/.betterclaw/channels.yaml`
2. Run `/notifications_enable` in Telegram
3. Check the cron task has `notifyUser: true`
