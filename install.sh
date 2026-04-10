#!/bin/bash
set -e

CONFIG_DIR="$HOME/.blackdogbot"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
COMPOSE_FILE="$CONFIG_DIR/docker-compose.yaml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SEARXNG_PORT=18731
CRAWL4AI_PORT=18732

print_header() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║           BlackDogBot Installation Script                  ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}!${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${CYAN}→${NC} $1"
}

prompt_input() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"
    
    if [ -n "$default" ]; then
        echo -ne "${BLUE}?${NC} ${prompt} [${default}]: "
    else
        echo -ne "${BLUE}?${NC} ${prompt}: "
    fi
    
    read -r input
    
    if [ -z "$input" ] && [ -n "$default" ]; then
        eval "$var_name=\"$default\""
    else
        eval "$var_name=\"$input\""
    fi
}

prompt_required() {
    local prompt="$1"
    local var_name="$2"
    
    while true; do
        echo -ne "${BLUE}?${NC} ${prompt}: "
        read -r input
        if [ -n "$input" ]; then
            eval "$var_name=\"$input\""
            break
        fi
        print_error "This field is required"
    done
}

prompt_yesno() {
    local prompt="$1"
    local default="$2"
    
    if [ "$default" = "y" ]; then
        echo -ne "${BLUE}?${NC} ${prompt} [Y/n]: "
    else
        echo -ne "${BLUE}?${NC} ${prompt} [y/N]: "
    fi
    
    read -r answer
    
    if [ -z "$answer" ]; then
        answer="$default"
    fi
    
    [[ "$answer" =~ ^[Yy]$ ]]
}

check_dependencies() {
    echo -e "${YELLOW}Checking dependencies...${NC}"
    
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed. Please install Node.js 22+ first."
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 22 ]; then
        print_error "Node.js version 22+ is required. Current version: $(node -v)"
        exit 1
    fi
    print_success "Node.js $(node -v)"
    
    if ! command -v pnpm &> /dev/null; then
        print_warning "pnpm not found. Installing..."
        npm install -g pnpm
        print_success "pnpm installed"
    else
        print_success "pnpm $(pnpm -v)"
    fi
    
    if ! command -v dot &> /dev/null; then
        print_warning "Graphviz (dot) not found. Graph rendering will not work."
        print_warning "Install with: sudo pacman -S graphviz (Arch) or sudo apt install graphviz (Debian/Ubuntu)"
    else
        print_success "Graphviz $(dot -V 2>&1 | cut -d' ' -f5)"
    fi
    
    if command -v docker &> /dev/null; then
        print_success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
        HAS_DOCKER=true
    else
        print_warning "Docker not found. Optional services (SearXNG, Crawl4AI) will not be available."
        HAS_DOCKER=false
    fi
    
    echo ""
}

get_script_dir() {
    cd "$(dirname "$0")" && pwd
}

install_dependencies() {
    echo -e "${YELLOW}Installing dependencies...${NC}"
    
    SCRIPT_DIR=$(get_script_dir)
    cd "$SCRIPT_DIR"
    
    pnpm install
    print_success "Dependencies installed"
    
    # Verify native addons were built correctly
    echo -e "${YELLOW}Verifying native addons...${NC}"
    
    # Check better-sqlite3
    SQLITE_BINDING=$(find node_modules -name "better_sqlite3.node" -type f 2>/dev/null | head -1)
    if [ -z "$SQLITE_BINDING" ]; then
        print_warning "better-sqlite3 native addon not found, rebuilding..."
        pnpm rebuild better-sqlite3 2>/dev/null || true
        SQLITE_BINDING=$(find node_modules -name "better_sqlite3.node" -type f 2>/dev/null | head -1)
        if [ -n "$SQLITE_BINDING" ]; then
            print_success "better-sqlite3 rebuilt successfully"
        else
            print_error "Failed to build better-sqlite3. You may need to install build tools (gcc, make, python3)"
        fi
    else
        print_success "better-sqlite3 native addon OK"
    fi
    
    echo ""
}

setup_docker_services() {
    if [ "$HAS_DOCKER" = false ]; then
        print_warning "Skipping Docker services setup (Docker not installed)"
        START_SERVICES=false
        SETUP_SEARXNG=false
        SETUP_CRAWL4AI=false
        SEARXNG_URL=""
        CRAWL4AI_URL=""
        return
    fi
    
    echo -e "${YELLOW}Docker Services Setup${NC}"
    echo "BlackDogBot can use SearXNG (web search) and Crawl4AI (web scraping) as Docker containers."
    echo ""
    
    if prompt_yesno "Set up SearXNG for web search?" "y"; then
        SETUP_SEARXNG=true
        SEARXNG_URL="http://localhost:$SEARXNG_PORT"
        print_info "SearXNG will be available at $SEARXNG_URL"
    else
        SETUP_SEARXNG=false
        prompt_input "SearXNG URL (if you have your own instance)" "" SEARXNG_URL
    fi
    
    if prompt_yesno "Set up Crawl4AI for web scraping?" "y"; then
        SETUP_CRAWL4AI=true
        CRAWL4AI_URL="http://localhost:$CRAWL4AI_PORT"
        print_info "Crawl4AI will be available at $CRAWL4AI_URL"
    else
        SETUP_CRAWL4AI=false
        prompt_input "Crawl4AI URL (if you have your own instance)" "" CRAWL4AI_URL
    fi
    
    START_SERVICES=false
    if [ "$SETUP_SEARXNG" = true ] || [ "$SETUP_CRAWL4AI" = true ]; then
        if prompt_yesno "Start services now?" "y"; then
            START_SERVICES=true
        fi
    fi
    
    echo ""
}

create_docker_compose() {
    if [ "$SETUP_SEARXNG" = false ] && [ "$SETUP_CRAWL4AI" = false ]; then
        return
    fi
    
    echo -e "${YELLOW}Creating Docker Compose configuration...${NC}"
    
    mkdir -p "$CONFIG_DIR"
    
    cat > "$COMPOSE_FILE" << 'EOF'
# BlackDogBot optional services
# Run with: docker compose -f ~/.blackdogbot/docker-compose.yaml up -d

services:
EOF

    if [ "$SETUP_SEARXNG" = true ]; then
        # Create SearXNG settings with JSON API enabled and bot detection disabled
        mkdir -p "$CONFIG_DIR/searxng"
        
        SEARXNG_SECRET=$(openssl rand -hex 32)
        
        cat > "$CONFIG_DIR/searxng/settings.yml" << SEARXNG_EOF
# SearXNG settings for BlackDogBot
# Bot detection disabled for local usage

use_default_settings: true

general:
  instance_name: "BlackDogBot Search"

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "all"
  formats:
    - html
    - json

server:
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "${SEARXNG_SECRET}"
  limiter: false
  image_proxy: true
  http_protocol_version: "1.1"
  method: "GET"

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

engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    disabled: false
  - name: bing
    engine: bing
    shortcut: bing
    disabled: false
SEARXNG_EOF
        
        cat >> "$COMPOSE_FILE" << EOF
  searxng:
    image: searxng/searxng:latest
    container_name: blackdogbot-searxng
    ports:
      - "${SEARXNG_PORT}:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:${SEARXNG_PORT}/
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

EOF
    fi

    if [ "$SETUP_CRAWL4AI" = true ]; then
        cat >> "$COMPOSE_FILE" << EOF
  crawl4ai:
    image: unclecode/crawl4ai:latest
    container_name: blackdogbot-crawl4ai
    ports:
      - "${CRAWL4AI_PORT}:11235"
    environment:
      - CRAWL4AI_API_TOKEN=
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11235/health"]
      interval: 30s
      timeout: 10s
      retries: 3

EOF
    fi
    
    print_success "Created $COMPOSE_FILE"
    
    if [ "$SETUP_SEARXNG" = true ]; then
        print_success "Created $CONFIG_DIR/searxng/settings.yml with JSON API enabled"
    fi
}

start_docker_services() {
    if [ "$START_SERVICES" = false ]; then
        return
    fi
    
    echo ""
    echo -e "${YELLOW}Starting Docker services...${NC}"
    
    cd "$CONFIG_DIR"
    
    if [ "$SETUP_SEARXNG" = true ]; then
        print_info "Pulling SearXNG image..."
        docker compose pull searxng 2>/dev/null || docker-compose pull searxng 2>/dev/null || true
    fi
    
    if [ "$SETUP_CRAWL4AI" = true ]; then
        print_info "Pulling Crawl4AI image..."
        docker compose pull crawl4ai 2>/dev/null || docker-compose pull crawl4ai 2>/dev/null || true
    fi
    
    print_info "Starting services..."
    if docker compose up -d 2>/dev/null; then
        print_success "Services started"
    elif docker-compose up -d 2>/dev/null; then
        print_success "Services started"
    else
        print_error "Failed to start services. Try manually: docker compose -f $COMPOSE_FILE up -d"
    fi
    
    print_info "Waiting for services to be ready..."
    sleep 5
    
    if [ "$SETUP_SEARXNG" = true ]; then
        if curl -s "http://localhost:$SEARXNG_PORT" > /dev/null 2>&1; then
            print_success "SearXNG is responding"
        else
            print_warning "SearXNG not responding yet (may need more time to start)"
        fi
    fi
    
    if [ "$SETUP_CRAWL4AI" = true ]; then
        if curl -s "http://localhost:$CRAWL4AI_PORT/health" > /dev/null 2>&1; then
            print_success "Crawl4AI is responding"
        else
            print_warning "Crawl4AI not responding yet (may need more time to start)"
        fi
    fi
}

create_systemd_service() {
    echo ""
    echo -e "${YELLOW}Systemd Service Setup${NC}"

    if ! prompt_yesno "Install BlackDogBot as a systemd service?" "y"; then
        SYSTEMD_INSTALLED=false
        return
    fi

    echo ""
    echo "This step requires sudo and will create:"
    echo "  - /usr/local/bin/blackdogbot-start"
    echo "  - /etc/systemd/system/blackdogbot.service"

    if ! prompt_yesno "Proceed with sudo for systemd setup?" "y"; then
        print_warning "Skipping systemd service setup"
        SYSTEMD_INSTALLED=false
        return
    fi

    SCRIPT_DIR=$(get_script_dir)
    SERVICE_USER="${SUDO_USER:-${USER:-$(whoami)}}"

    if [ -z "$SERVICE_USER" ]; then
        prompt_input "Run service as user" "$(whoami)" SERVICE_USER
    fi

    LAUNCH_WRAPPER="/usr/local/bin/blackdogbot-start"
    SYSTEMD_UNIT="/etc/systemd/system/blackdogbot.service"

    echo -e "${YELLOW}Creating launch wrapper...${NC}"
    sudo tee "$LAUNCH_WRAPPER" > /dev/null << EOF
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${SCRIPT_DIR}"

find_cuda12_dir() {
    if ldconfig -p 2>/dev/null | grep -q 'libcublasLt.so.12'; then
        return 0
    fi

    local candidates=(
        "/usr/local/lib/ollama/cuda_v12"
        "/usr/lib/ollama/cuda_v12"
    )

    for dir in "\${candidates[@]}"; do
        if [[ -f "\$dir/libcublasLt.so.12" ]]; then
            echo "\$dir"
            return 0
        fi
    done

    return 1
}

cuda12_dir=\$(find_cuda12_dir 2>/dev/null || true)
if [[ -n "\$cuda12_dir" ]]; then
    export LD_LIBRARY_PATH="\${cuda12_dir}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
fi

cd "\$REPO_DIR"
pnpm install --frozen-lockfile
pnpm build
exec node dist/index.js
EOF
    sudo chmod +x "$LAUNCH_WRAPPER"
    print_success "Created $LAUNCH_WRAPPER"

    echo -e "${YELLOW}Creating systemd unit...${NC}"
    sudo tee "$SYSTEMD_UNIT" > /dev/null << EOF
[Unit]
Description=BlackDogBot AI Assistant Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${LAUNCH_WRAPPER}
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    print_success "Created $SYSTEMD_UNIT"

    sudo systemctl daemon-reload
    print_success "Reloaded systemd daemon"

    if prompt_yesno "Enable service to start on boot?" "y"; then
        sudo systemctl enable blackdogbot
        print_success "Service enabled for boot"
    fi

    if prompt_yesno "Start service now?" "y"; then
        sudo systemctl start blackdogbot
        sleep 2

        if sudo systemctl is-active --quiet blackdogbot; then
            print_success "Service started successfully"
        else
            print_warning "Service did not report active status yet"
            print_info "Check logs: sudo journalctl -u blackdogbot -n 50"
        fi
    fi

    SYSTEMD_INSTALLED=true
    SYSTEMD_SERVICE_USER="$SERVICE_USER"
}

create_config() {
    echo -e "${YELLOW}Configuration Setup${NC}"
    echo ""
    
    mkdir -p "$CONFIG_DIR"
    print_success "Created $CONFIG_DIR"
    
    if [ -f "$CONFIG_FILE" ]; then
        echo -e "${YELLOW}Existing config found at $CONFIG_FILE${NC}"
        echo -ne "${BLUE}?${NC} Overwrite existing config? [y/N]: "
        read -r overwrite
        if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
            print_warning "Keeping existing config"
            return
        fi
    fi
    
    echo ""
    echo -e "${BLUE}AI Provider Configuration${NC}"
    echo "1) OpenRouter (recommended)"
    echo "2) OpenAI-compatible (Ollama, vLLM, etc.)"
    echo "3) LM Studio (local)"
    echo ""
    prompt_input "Select AI provider" "1" provider_choice
    
    if [ "$provider_choice" = "1" ]; then
        AI_PROVIDER="openrouter"
        prompt_required "OpenRouter API key (sk-or-...)" OPENROUTER_KEY
        prompt_input "Model to use" "anthropic/claude-sonnet-4" OPENROUTER_MODEL
        prompt_input "Requests per minute (RPM)" "60" OPENROUTER_RPM
        prompt_input "Tokens per minute (TPM)" "100000" OPENROUTER_TPM
    elif [ "$provider_choice" = "2" ]; then
        AI_PROVIDER="openai-compatible"
        prompt_input "Base URL" "http://localhost:11434" OAI_BASE_URL
        prompt_input "API key (optional, press Enter to skip)" "" OAI_KEY
        prompt_input "Model name" "llama3" OAI_MODEL
        prompt_input "Requests per minute (RPM)" "120" OAI_RPM
        prompt_input "Tokens per minute (TPM)" "200000" OAI_TPM
    else
        AI_PROVIDER="lm-studio"
        prompt_input "LM Studio base URL" "http://localhost:1234" LMSTUDIO_BASE_URL
        prompt_input "Model name (from LM Studio)" "" LMSTUDIO_MODEL
        prompt_input "Requests per minute (RPM)" "120" LMSTUDIO_RPM
        prompt_input "Tokens per minute (TPM)" "200000" LMSTUDIO_TPM
    fi
    
    echo ""
    echo -e "${BLUE}Telegram Configuration (optional)${NC}"
    echo "Leave empty to skip Telegram integration"
    echo ""
    prompt_input "Telegram Bot Token" "" TELEGRAM_TOKEN
    
    echo ""
    echo -e "${BLUE}Discord Configuration (optional)${NC}"
    echo "Leave empty to skip Discord integration"
    echo ""
    prompt_input "Discord Bot Token" "" DISCORD_TOKEN

    echo ""
    echo -e "${BLUE}Scheduler Configuration${NC}"
    
    DETECTED_TZ=""
    if command -v timedatectl &> /dev/null; then
        DETECTED_TZ=$(timedatectl show --property=Timezone --value 2>/dev/null || echo "")
    fi
    if [ -z "$DETECTED_TZ" ] && [ -f /etc/timezone ]; then
        DETECTED_TZ=$(cat /etc/timezone 2>/dev/null || echo "")
    fi
    
    if prompt_yesno "Enable scheduler?" "y"; then
        SCHEDULER_ENABLED="true"
        if [ -n "$DETECTED_TZ" ]; then
            prompt_input "Scheduler timezone" "$DETECTED_TZ" SCHEDULER_TZ
        else
            prompt_input "Scheduler timezone (e.g., Europe/Prague)" "UTC" SCHEDULER_TZ
        fi
    else
        SCHEDULER_ENABLED="false"
        SCHEDULER_TZ="UTC"
    fi
    
    echo ""
    echo -e "${BLUE}Embedding Configuration${NC}"
    echo "Embeddings are used for knowledge search (RAG)."
    echo ""
    echo "1) Local (recommended - runs on your machine)"
    echo "2) OpenRouter (uses cloud API)"
    echo ""
    prompt_input "Embedding provider" "1" embedding_choice
    
    if [ "$embedding_choice" = "1" ]; then
        EMBEDDING_PROVIDER="local"
        EMBEDDING_MODEL_PATH="onnx-community/Qwen3-Embedding-0.6B-ONNX"
        echo ""
        echo "Device selection:"
        echo "1) auto (detect best available)"
        echo "2) cpu (force CPU)"
        echo "3) cuda (force NVIDIA GPU)"
        prompt_input "Embedding device" "1" device_choice
        case $device_choice in
            2) EMBEDDING_DEVICE="cpu" ;;
            3) EMBEDDING_DEVICE="cuda" ;;
            *) EMBEDDING_DEVICE="auto" ;;
        esac
        echo ""
        echo "Quantization (smaller = faster, slightly less accurate):"
        echo "1) q8 (recommended - good balance)"
        echo "2) fp16 (more accurate, larger)"
        echo "3) fp32 (full precision, largest)"
        prompt_input "Quantization type" "1" dtype_choice
        case $dtype_choice in
            2) EMBEDDING_DTYPE="fp16" ;;
            3) EMBEDDING_DTYPE="fp32" ;;
            *) EMBEDDING_DTYPE="q8" ;;
        esac
    else
        EMBEDDING_PROVIDER="openrouter"
        if [ "$AI_PROVIDER" = "openrouter" ] && [ -n "$OPENROUTER_KEY" ]; then
            EMBEDDING_OR_KEY="$OPENROUTER_KEY"
        else
            prompt_required "OpenRouter API key for embeddings" EMBEDDING_OR_KEY
        fi
        prompt_input "Embedding model" "nvidia/llama-nemotron-embed-vl-1b-v2:free" EMBEDDING_OR_MODEL
    fi
    
    echo ""
    echo -e "${BLUE}Logging${NC}"
    echo "1) debug  2) info  3) warn  4) error"
    prompt_input "Log level" "2" log_level_choice
    case $log_level_choice in
        1) LOG_LEVEL="debug" ;;
        3) LOG_LEVEL="warn" ;;
        4) LOG_LEVEL="error" ;;
        *) LOG_LEVEL="info" ;;
    esac
    
    cat > "$CONFIG_FILE" << EOF
ai:
  provider: ${AI_PROVIDER}
EOF

    if [ "$AI_PROVIDER" = "openrouter" ]; then
        cat >> "$CONFIG_FILE" << EOF
  openrouter:
    apiKey: ${OPENROUTER_KEY}
    model: ${OPENROUTER_MODEL}
    rateLimits:
      rpm: ${OPENROUTER_RPM}
      tpm: ${OPENROUTER_TPM}
EOF
    elif [ "$AI_PROVIDER" = "openai-compatible" ]; then
        cat >> "$CONFIG_FILE" << EOF
  openaiCompatible:
    baseUrl: ${OAI_BASE_URL}
    apiKey: ${OAI_KEY}
    model: ${OAI_MODEL}
    rateLimits:
      rpm: ${OAI_RPM}
      tpm: ${OAI_TPM}
EOF
    else
        cat >> "$CONFIG_FILE" << EOF
  lmStudio:
    baseUrl: ${LMSTUDIO_BASE_URL}
    model: ${LMSTUDIO_MODEL}
    rateLimits:
      rpm: ${LMSTUDIO_RPM}
      tpm: ${LMSTUDIO_TPM}
EOF
    fi

    if [ -n "$TELEGRAM_TOKEN" ]; then
        cat >> "$CONFIG_FILE" << EOF

telegram:
  botToken: ${TELEGRAM_TOKEN}
EOF
    fi

    if [ -n "$DISCORD_TOKEN" ]; then
        cat >> "$CONFIG_FILE" << EOF

discord:
  botToken: ${DISCORD_TOKEN}
EOF
    fi

    cat >> "$CONFIG_FILE" << EOF

scheduler:
  enabled: ${SCHEDULER_ENABLED}
  timezone: ${SCHEDULER_TZ}

knowledge:
  embeddingProvider: ${EMBEDDING_PROVIDER}
EOF

    if [ "$EMBEDDING_PROVIDER" = "local" ]; then
        cat >> "$CONFIG_FILE" << EOF
  embeddingModelPath: ${EMBEDDING_MODEL_PATH}
  embeddingDtype: ${EMBEDDING_DTYPE}
  embeddingDevice: ${EMBEDDING_DEVICE}
EOF
    else
        cat >> "$CONFIG_FILE" << EOF
  embeddingOpenRouterApiKey: ${EMBEDDING_OR_KEY}
  embeddingOpenRouterModel: ${EMBEDDING_OR_MODEL}
EOF
    fi

    cat >> "$CONFIG_FILE" << EOF
  lancedbPath: ~/.blackdogbot/knowledge/lancedb

skills:
  directories: []

logging:
  level: ${LOG_LEVEL}
EOF

    # Only write services block if at least one URL is set
    if [ -n "$SEARXNG_URL" ] || [ -n "$CRAWL4AI_URL" ]; then
        echo "" >> "$CONFIG_FILE"
        echo "services:" >> "$CONFIG_FILE"
        [ -n "$SEARXNG_URL" ] && echo "  searxngUrl: ${SEARXNG_URL}" >> "$CONFIG_FILE"
        [ -n "$CRAWL4AI_URL" ] && echo "  crawl4aiUrl: ${CRAWL4AI_URL}" >> "$CONFIG_FILE"
    fi

    print_success "Created $CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    print_success "Set restrictive permissions on config"
}

create_directories() {
    echo ""
    echo -e "${YELLOW}Creating directories...${NC}"
    
    mkdir -p "$CONFIG_DIR/skills"
    mkdir -p "$CONFIG_DIR/knowledge/lancedb"
    mkdir -p "$CONFIG_DIR/cron"
    mkdir -p "$CONFIG_DIR/logs"
    mkdir -p "$CONFIG_DIR/workspace"
    mkdir -p "$CONFIG_DIR/prompts/prompt-fragments"
    mkdir -p "$CONFIG_DIR/model-profiles"
    mkdir -p "$CONFIG_DIR/rss-state"
    mkdir -p "$CONFIG_DIR/databases"
    mkdir -p "$CONFIG_DIR/sessions"
    mkdir -p "$CONFIG_DIR/models"
    
    print_success "Created all required directories"
}

copy_default_prompts() {
    SCRIPT_DIR=$(get_script_dir)
    PROMPTS_SRC="$SCRIPT_DIR/src/defaults/prompts"
    PROMPTS_DEST="$CONFIG_DIR/prompts"
    
    if [ -d "$PROMPTS_SRC" ]; then
        echo ""
        echo -e "${YELLOW}Copying default prompts...${NC}"
        
        if [ ! -d "$PROMPTS_DEST" ] || [ -z "$(ls -A "$PROMPTS_DEST" 2>/dev/null | grep -v prompt-fragments)" ]; then
            cp -r "$PROMPTS_SRC"/* "$PROMPTS_DEST/" 2>/dev/null || true
            print_success "Copied default prompts to $PROMPTS_DEST"
        else
            print_warning "Prompts directory already populated, skipping"
        fi
    fi
}

print_summary() {
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              Installation Complete!                        ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Configuration: $CONFIG_FILE"
    
    if [ -f "$COMPOSE_FILE" ]; then
        echo "Docker Compose: $COMPOSE_FILE"
    fi
    
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "  1. Review your config: cat $CONFIG_FILE"
    
    if [ -f "$COMPOSE_FILE" ] && [ "$START_SERVICES" = false ]; then
        echo "  2. Start Docker services: docker compose -f $COMPOSE_FILE up -d"
        echo "  3. Start the daemon:       pnpm start"
        echo "  4. Watch mode (dev):       pnpm dev"
    else
        echo "  2. Start the daemon:       pnpm start"
        echo "  3. Watch mode (dev):       pnpm dev"
    fi
    
    echo ""
    echo -e "${YELLOW}First run will download the embedding model (~2.1 GB)${NC}"
    echo ""
    
    if [ -f "$COMPOSE_FILE" ]; then
        echo -e "${CYAN}Docker service management:${NC}"
        echo "  Start:   docker compose -f $COMPOSE_FILE up -d"
        echo "  Stop:    docker compose -f $COMPOSE_FILE down"
        echo "  Logs:    docker compose -f $COMPOSE_FILE logs -f"
        echo "  Status:  docker compose -f $COMPOSE_FILE ps"
        echo ""
    fi

    if [ "$SYSTEMD_INSTALLED" = true ]; then
        echo -e "${CYAN}Systemd service:${NC}"
        echo "  Service: blackdogbot"
        echo "  User:    $SYSTEMD_SERVICE_USER"
        echo "  Status:  sudo systemctl status blackdogbot"
        echo "  Logs:    sudo journalctl -u blackdogbot -f"
        echo ""
    fi
}

main() {
    print_header
    check_dependencies
    install_dependencies
    setup_docker_services
    create_docker_compose
    create_config
    create_directories
    copy_default_prompts
    start_docker_services
    create_systemd_service
    print_summary
}

main "$@"
