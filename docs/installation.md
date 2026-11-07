# BlackDogBot Installation Guide

## Requirements

- Node.js >= 22 (including Node.js 26)
- pnpm
- Git (for updating)
- Docker & Docker Compose (optional, for SearXNG and Scrapling services)

## Quick Install

For a fresh, non-root Linux installation, run in an interactive terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/mistrjirka/BlackDogBot/main/scripts/bootstrap.sh | sh
```

The short POSIX bootstrap script clones the source and launches the interactive Bash
installer using `/dev/tty` (the `curl` pipe is not interactive). It never
uses sudo and refuses to overwrite an existing config.

For review before execution:

```sh
curl -fsSLo /tmp/blackdogbot-bootstrap.sh https://raw.githubusercontent.com/mistrjirka/BlackDogBot/main/scripts/bootstrap.sh
less /tmp/blackdogbot-bootstrap.sh
sh /tmp/blackdogbot-bootstrap.sh
```

The moving `main` reference is not cryptographically pinned; use
a reviewed tag/commit when reproducibility is important.

Alternatively, install from a Git checkout:

```sh
git clone https://github.com/mistrjirka/BlackDogBot.git
cd BlackDogBot
./install.sh
```

Requirements: Node.js 22+, Bash, Git, a systemd **user** session, and pnpm
(installed by the wizard if missing). Docker Engine and Compose are optional.
The wizard configures the model, messaging, SearXNG and Scrapling, and installs
a **non-root user service** by default. It then prepares and starts a tested
guarded release. It does **not** overwrite existing installations.

To keep the user service active before login, an administrator may separately
run `sudo loginctl enable-linger "$USER"`. This is optional.

**Updates:** Never rerun `install.sh` to upgrade. Follow
[guarded self-updates](guarded-self-update.md).

## Manual Installation

### 1. Install Dependencies

```bash
pnpm install --frozen-lockfile
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

# Web search servers are registered in ~/.blackdogbot/mcp-servers.json.
```

The wizard offers **three MCP servers**: SearXNG (search), Scrapling (scraping), and Playwright (browser interaction and screenshots). All three are selected by default if Docker is available. The SearXNG adapter is installed into a user-local directory as pinned `mcp-searxng@2.10.0`. Playwright uses pinned `@playwright/mcp@0.0.84` and automatically downloads the exact Firefox build required by its bundled Playwright runtime. These Node packages work on Linux x86-64 and arm64. The two Docker image digests below publish both architectures.

Both Docker services are optional. Without Docker, the wizard can register an existing remote SearXNG or Scrapling endpoint, and Playwright can still be installed locally. The wizard tests the actual MCP handshake and tool list for configured servers. For Playwright, it also launches Firefox and captures a screenshot. Services intentionally left stopped are not claimed as verified.

All registrations live in `~/.blackdogbot/mcp-servers.json`. MCP Node packages live in `~/.local/share/blackdogbot/mcp/`; Playwright's matching browser is stored in its own `playwright/browsers/` directory to avoid affecting other browser installations.

### 3. Set Up Docker Services (Optional)

Create `~/.blackdogbot/docker-compose.yaml`:

```yaml
services:
  searxng:
    image: searxng/searxng@sha256:c750ee1d859b26d3aeae51c07f6a48c3a0bfbaa9195d71a18b258862d88c4c3c
    container_name: blackdogbot-searxng
    ports:
      - "127.0.0.1:18731:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:18731/
      - SEARXNG_SECRET=<generate-with-openssl-rand-hex-32>
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    restart: unless-stopped

  scrapling:
    image: pyd4vinci/scrapling@sha256:b4e92cde7e7e2d9f5940e90ee796cbf7340843a6de7213c0c409fe3d2aadfd87
    container_name: blackdogbot-scrapling
    ports:
      - "127.0.0.1:18733:8000"
    env_file:
      - ./scrapling.env
    command: ["mcp", "--http", "--host", "0.0.0.0", "--port", "8000"]
    shm_size: 1g
    mem_limit: 4g
    pids_limit: 300
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python3", "-c", "import socket; s=socket.create_connection(('127.0.0.1',8000),3); s.close()"]

```
To create a private authentication file on fresh installations:

```bash
umask 077
printf 'SCRAPLING_MCP_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/.blackdogbot/scrapling.env
chmod 600 ~/.blackdogbot/scrapling.env
docker compose -f ~/.blackdogbot/docker-compose.yaml up -d scrapling
```

The installer creates the same authenticated, localhost-only HTTP MCP service and registers it under mcpServers.scrapling. The bearer token remains in a protected file. See the guarded Docker upgrade guide for digest updates and rollback.

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



## User service and automatic updates

The installer calls `scripts/install-user-service.sh`, which creates
`~/.config/systemd/user/blackdogbot.service` without root privileges.
The initial Git revision is prepared in a test worktree and activated through
the independent guarded release manager. It may take time to build and test
on first installation.

```sh
systemctl --user status blackdogbot.service
journalctl --user -u blackdogbot.service -f
```

Old root-managed services must be migrated separately to avoid having two
competing bots polling the same Telegram token. The helper refuses to overwrite
an existing user service.

SearXNG and Scrapling are pinned to immutable image digests. Every successful
guarded code update checks their upstream `latest` digests and updates
each configured Docker service with canary validation and service-local
rollback. Use `--skip-container-updates` to deploy only application code.
See [guarded Docker updates](guarded-container-update.md).
