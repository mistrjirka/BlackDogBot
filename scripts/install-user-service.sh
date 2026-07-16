#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SERVICE_DIR/blackdogbot.service"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is not available on PATH; install Node.js before enabling the service." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=BlackDogBot daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=HOME=$HOME
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin
ExecStart=$PROJECT_DIR/scripts/launch.sh
Restart=on-failure
RestartSec=5s
KillSignal=SIGINT
TimeoutStopSec=30s

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable blackdogbot.service
systemctl --user restart blackdogbot.service

echo "Installed and started $SERVICE_PATH"
