# BetterClaw Installation Guide

## Requirements

- Node.js >= 22
- pnpm
- Git (for updating)
- Docker & Docker Compose (optional, for SearXNG and Crawl4AI services)

## Quick Install

Run the interactive install script:

```bash
./install.sh
```

> **Tip:** For easiest updates, clone the repository instead of downloading a ZIP:
> ```bash
> git clone https://github.com/your-repo/better-claw.git
> cd better-claw
> ./install.sh
> ```
> Then later you can update with `git pull`.

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
    container_name: betterclaw-searxng
    ports:
      - "18731:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:18731/
      - SEARXNG_SECRET=<generate-with-openssl-rand-hex-32>
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    restart: unless-stopped

  crawl4ai:
    image: unclecode/crawl4ai:latest
    container_name: betterclaw-crawl4ai
    ports:
      - "18732:8000"
    restart: unless-stopped
```

**Important:** SearXNG requires a `settings.yml` file to enable JSON API access and disable bot detection for local use.

Create `~/.betterclaw/searxng/settings.yml`:

```yaml
use_default_settings: true

general:
  instance_name: "BetterClaw Search"

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "all"
  formats:
    - html
    - json    # Required for BetterClaw API access

server:
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "<your-secret-key>"  # Generate with: openssl rand -hex 32
  limiter: false
  image_proxy: true
  http_protocol_version: "1.1"
  method: "GET"

# Critical: Disable bot detection for local usage
botdetection:
  ip_enabled: false
  ip_lists:
    pass_ip:
      - 127.0.0.0/8
      - ::1/128
      - 172.16.0.0/12
      - 192.168.0.0/16
    block_ip: []
  link_token: false

outgoing:
  request_timeout: 10.0
  max_request_timeout: 15.0
  pool_connections: 100
  pool_maxsize: 20
```

Start services:

```bash
docker compose -f ~/.betterclaw/docker-compose.yaml up -d
```

Verify SearXNG is working:

```bash
curl 'http://localhost:18731/search?q=test&format=json'
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
    contextWindow: 8192  # Optional: specify context window size
    rateLimits:
      rpm: 120
      tpm: 200000
```

**LM Studio:**
```yaml
ai:
  provider: lm-studio
  lmStudio:
    baseUrl: http://localhost:1234/v1
    apiKey: lm-studio  # Default API key for LM Studio
    model: models/YourModelName  # Model identifier as shown in LM Studio
    contextWindow: 8192  # Optional: auto-detected if not specified
    rateLimits:
      rpm: 120
      tpm: 200000
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
  embeddingDevice: auto  # Options: auto, cpu, cuda
  embeddingDtype: q8     # Options: fp32, fp16, q8, q4, q4f16
```

**OpenRouter:**
```yaml
knowledge:
  embeddingProvider: openrouter
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
```

#### Embedding Device Configuration

For local embeddings, you can control the compute device:
- `auto` (default): Automatically detects and uses GPU (CUDA) if available, falls back to CPU
- `cpu`: Force CPU usage regardless of GPU availability
- `cuda`: Force CUDA (NVIDIA GPU) usage

To force CPU usage (e.g., on systems without CUDA 12 libraries or to reduce memory usage):
```yaml
knowledge:
  embeddingProvider: local
  embeddingDevice: cpu
```

### Scheduler

Configure the cron-like scheduler:
```yaml
scheduler:
  enabled: true  # Enable/disable the scheduler
  timezone: Europe/Prague  # Optional: timezone for cron expressions
```

### Job Creation

Configure job creation behavior:
```yaml
jobCreation:
  enabled: true  # Enable/disable job creation feature
  requirePassingNodeTests: true  # Require all node tests to pass before finish_job_creation
  requireSuccessfulRunBeforeFinish: true  # Require successful job execution before marking ready
```

### Skills

Configure skill loading and setup:
```yaml
skills:
  directories:
    - ~/.betterclaw/skills  # Directories to scan for skills
  autoSetup: true  # Automatically set up skills with missing dependencies
  autoSetupNotify: true  # Send notifications when skill setup completes/fails
  installTimeout: 300000  # Timeout in milliseconds for each install step (5 minutes)
  allowedInstallKinds:
    - brew
    - node
    - go
    - uv
    # - pacman  # Requires manual steps
    # - apt     # Requires manual steps
    # - download  # Requires manual steps
  skipOsCheck: false  # Skip OS compatibility check for skills
```

### Logging

Configure logging behavior:
```yaml
logging:
  level: info  # Options: debug, info, warn, error
```

### Services

Configure external services:
```yaml
services:
  searxngUrl: http://localhost:18731  # SearXNG instance URL
  crawl4aiUrl: http://localhost:18732  # Crawl4AI instance URL
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

The first run downloads the embedding model (several hundred MB depending on quantization). If it fails:
1. Check internet connection
2. Try clearing the cache: `rm -rf ~/.cache/huggingface/`
3. Run again

### Cron Tasks Not Sending Notifications

1. Ensure channels have `receiveNotifications: true` in `~/.betterclaw/channels.yaml`
2. Run `/notifications_enable` in Telegram
3. Check the cron task has `notifyUser: true`
