#!/usr/bin/env bash
# Install a non-root systemd user service. Guarded release bootstrapping is
# performed by the interactive installer after initial service startup.
set -euo pipefail
if [[ ${EUID} -eq 0 ]]; then
  echo "Run as the target user, not root. No sudo is required." >&2; exit 1
fi
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
systemctl --user show-environment >/dev/null || { echo "No systemd user manager; log in with a user session." >&2; exit 1; }
NODE_BIN=$(command -v node || true)
[[ -n "$NODE_BIN" ]] || { echo "Node.js 22+ required" >&2; exit 1; }
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SERVICE_DIR/blackdogbot.service"
if [[ -e "$SERVICE_PATH" || -L "$SERVICE_PATH" ]]; then
  echo "Existing user service $SERVICE_PATH; refusing to overwrite it." >&2; exit 1
fi
mkdir -p "$SERVICE_DIR"
NODE_DIR=$(dirname -- "$NODE_BIN")
# Escaping percent characters avoids systemd specifier expansion in paths.
for value in "$ROOT_DIR" "$HOME" "$NODE_DIR"; do
  [[ "$value" != *%* && "$value" != *$'\n'* ]] || { echo "Unsupported character in service path" >&2; exit 1; }
done
umask 077
cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=BlackDogBot AI assistant
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment=HOME=$HOME
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin
ExecStart=$ROOT_DIR/scripts/launch.sh
Restart=on-failure
RestartSec=5s
KillSignal=SIGINT
TimeoutStopSec=30s

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now blackdogbot.service
echo "Installed user service $SERVICE_PATH"
echo "Check: systemctl --user status blackdogbot.service"
echo "For start at boot without an interactive login, an administrator may enable:"
echo "  sudo loginctl enable-linger $(id -un)"
