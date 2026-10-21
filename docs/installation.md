# BlackDogBot Installation Guide

## Requirements

- Node.js >= 22 (including Node.js 26)
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
> git clone https://github.com/your-repo/blackdogbot.git
> cd blackdogbot
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

Create `~/.blackdogbot/config.yaml`:

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

knowledge:
  embeddingProvider: local
  embeddingModelPath: onnx-community/Qwen3-Embedding-0.6B-ONNX
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
  lancedbPath: ~/.blackdogbot/knowledge/lancedb

skills:
  directories: []

logging:
  level: info

services:
  searxngUrl: http://localhost:18731
```

Crawl4AI is registered separately as an MCP server in `~/.blackdogbot/mcp-servers.json`; the install script creates this entry when you enable Crawl4AI.

### 3. Set Up Docker Services (Optional)

Create `~/.blackdogbot/docker-compose.yaml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: blackdogbot-searxng
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
    container_name: blackdogbot-crawl4ai
    ports:
      - "127.0.0.1:18732:11235"
    environment:
      CRAWL4AI_API_TOKEN: ${CRAWL4AI_API_TOKEN:?Set in ~/.blackdogbot/.env}
    shm_size: 3g
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11235/health"]
```

Create a private token file before starting Compose (the installer does this for you):

```bash
umask 077
printf 'CRAWL4AI_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/.blackdogbot/.env
chmod 600 ~/.blackdogbot/.env
```

Crawl4AI is connected through its native MCP SSE endpoint at `http://127.0.0.1:18732/mcp/sse`. Its `mcp-servers.json` entry uses `transport: "sse"`, `strictOutputSchema: false`, and an `Authorization: Bearer <token>` header. Keep that file private (`chmod 600`); omitting `allowedTools` exposes all tools discovered from the server.

For a manual MCP setup, add this to `~/.blackdogbot/mcp-servers.json` (replace the placeholder with the token from `.env`):

```json
{
  "mcpServers": {
    "crawl4ai": {
      "url": "http://127.0.0.1:18732/mcp/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer <token>" },
      "strictOutputSchema": false
    }
  }
}
```

Then restrict the file permissions with `chmod 600 ~/.blackdogbot/mcp-servers.json`.

**Important:** SearXNG requires a `settings.yml` file to enable JSON API access and disable bot detection for local use.

Create `~/.blackdogbot/searxng/settings.yml`:

```yaml
use_default_settings: true

general:
  instance_name: "BlackDogBot Search"

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "all"
  formats:
    - html
    - json    # Required for BlackDogBot API access

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
docker compose -f ~/.blackdogbot/docker-compose.yaml up -d
```

Verify SearXNG is working:

```bash
curl 'http://localhost:18731/search?q=test&format=json'
```

### 4. Create Required Directories

```bash
mkdir -p ~/.blackdogbot/{prompts/prompt-fragments,cron,knowledge/lancedb,skills,logs,workspace,databases,rss-state,model-profiles,sessions,models}
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
Send any message to register the channel, then manually edit `~/.blackdogbot/channels.yaml` to set `receiveNotifications: true`.

### Verify Installation

Check the logs:

```bash
tail -f ~/.blackdogbot/logs/blackdogbot.log
```

For full config options, see [Configuration Guide](./configuration.md).
For troubleshooting, see [Troubleshooting Guide](./troubleshooting.md).
