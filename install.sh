#!/bin/bash
set -e

CONFIG_DIR="$HOME/.betterclaw"
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
    echo -e "${BLUE}║           BetterClaw Installation Script                  ║${NC}"
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
        print_warning "Graphviz (dot) not found. Job graph rendering will not work."
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
    echo ""
}

setup_docker_services() {
    if [ "$HAS_DOCKER" = false ]; then
        print_warning "Skipping Docker services setup (Docker not installed)"
        START_SERVICES=false
        SEARXNG_URL=""
        CRAWL4AI_URL=""
        return
    fi
    
    echo -e "${YELLOW}Docker Services Setup${NC}"
    echo "BetterClaw can use SearXNG (web search) and Crawl4AI (web scraping) as Docker containers."
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
# BetterClaw optional services
# Run with: docker compose -f ~/.betterclaw/docker-compose.yaml up -d

services:
EOF

    if [ "$SETUP_SEARXNG" = true ]; then
        cat >> "$COMPOSE_FILE" << EOF
  searxng:
    image: searxng/searxng:latest
    container_name: betterclaw-searxng
    ports:
      - "${SEARXNG_PORT}:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:${SEARXNG_PORT}/
      - SEARXNG_SECRET=$(openssl rand -hex 32)
    volumes:
      - searxng-data:/etc/searxng
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
    container_name: betterclaw-crawl4ai
    ports:
      - "${CRAWL4AI_PORT}:8000"
    environment:
      - CRAWL4AI_API_TOKEN=
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

EOF
    fi

    echo "volumes:" >> "$COMPOSE_FILE"
    if [ "$SETUP_SEARXNG" = true ]; then
        echo "  searxng-data:" >> "$COMPOSE_FILE"
    fi
    
    print_success "Created $COMPOSE_FILE"
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
    echo ""
    prompt_input "Select AI provider" "1" provider_choice
    
    if [ "$provider_choice" = "1" ]; then
        AI_PROVIDER="openrouter"
        prompt_required "OpenRouter API key (sk-or-...)" OPENROUTER_KEY
        prompt_input "Model to use" "anthropic/claude-sonnet-4" OPENROUTER_MODEL
        prompt_input "Requests per minute (RPM)" "60" OPENROUTER_RPM
        prompt_input "Tokens per minute (TPM)" "100000" OPENROUTER_TPM
    else
        AI_PROVIDER="openai-compatible"
        prompt_input "Base URL" "http://localhost:11434/v1" OAI_BASE_URL
        prompt_input "API key (optional, press Enter to skip)" "" OAI_KEY
        prompt_input "Model name" "llama3" OAI_MODEL
        prompt_input "Requests per minute (RPM)" "120" OAI_RPM
        prompt_input "Tokens per minute (TPM)" "200000" OAI_TPM
    fi
    
    echo ""
    echo -e "${BLUE}Telegram Configuration (optional)${NC}"
    echo "Leave empty to skip Telegram integration"
    echo ""
    prompt_input "Telegram Bot Token" "" TELEGRAM_TOKEN
    
    echo ""
    echo -e "${BLUE}Scheduler Configuration${NC}"
    if prompt_yesno "Enable scheduler?" "y"; then
        SCHEDULER_ENABLED="true"
        prompt_input "Notification Chat ID (optional)" "" NOTIFICATION_CHAT
    else
        SCHEDULER_ENABLED="false"
        NOTIFICATION_CHAT=""
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
    else
        cat >> "$CONFIG_FILE" << EOF
  openaiCompatible:
    baseUrl: ${OAI_BASE_URL}
    apiKey: ${OAI_KEY}
    model: ${OAI_MODEL}
    rateLimits:
      rpm: ${OAI_RPM}
      tpm: ${OAI_TPM}
EOF
    fi

    if [ -n "$TELEGRAM_TOKEN" ]; then
        cat >> "$CONFIG_FILE" << EOF

telegram:
  botToken: "${TELEGRAM_TOKEN}"
EOF
    fi

    cat >> "$CONFIG_FILE" << EOF

scheduler:
  enabled: ${SCHEDULER_ENABLED}
  notificationChatId: ${NOTIFICATION_CHAT:-null}

knowledge:
  embeddingModelPath: Xenova/bge-m3
  lancedbPath: ~/.betterclaw/knowledge/lancedb

skills:
  directories: []

logging:
  level: ${LOG_LEVEL}

services:
  searxngUrl: ${SEARXNG_URL:-null}
  crawl4aiUrl: ${CRAWL4AI_URL:-null}
EOF

    print_success "Created $CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    print_success "Set restrictive permissions on config"
}

create_directories() {
    echo ""
    echo -e "${YELLOW}Creating directories...${NC}"
    
    mkdir -p "$CONFIG_DIR/skills"
    mkdir -p "$CONFIG_DIR/jobs"
    mkdir -p "$CONFIG_DIR/knowledge/lancedb"
    mkdir -p "$CONFIG_DIR/cron"
    mkdir -p "$CONFIG_DIR/logs"
    mkdir -p "$CONFIG_DIR/workspace"
    mkdir -p "$CONFIG_DIR/prompts/prompt-fragments"
    mkdir -p "$CONFIG_DIR/rss-state"
    mkdir -p "$CONFIG_DIR/databases"
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
    print_summary
}

main "$@"
