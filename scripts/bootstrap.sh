#!/bin/sh
# Minimal curl | sh entry point. The actual interactive installer runs via bash
# with stdin attached to the terminal; no sudo and no hidden remote execution.
set -eu
REPOSITORY="https://github.com/mistrjirka/BlackDogBot.git"
REF="${BLACKDOGBOT_REF:-main}"
case "$REF" in *[!A-Za-z0-9._/-]* | "" | -* )
  echo "Invalid BLACKDOGBOT_REF" >&2; exit 1;; esac
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  echo "HOME must point to a writable user directory." >&2; exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the account that will own the service, not root/sudo." >&2; exit 1
fi
for cmd in git bash; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required; install it before running the bootstrapper." >&2; exit 1
  fi
done
if ! ( : </dev/tty ) 2>/dev/null; then
  echo "Interactive install requires a terminal; run in a real shell." >&2; exit 1
fi
DEST="${BLACKDOGBOT_SOURCE_DIR:-$HOME/.local/share/blackdogbot/source}"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "Source directory already exists: $DEST" >&2
  echo "For updates use the guarded release workflow, not the installer." >&2
  exit 1
fi
if [ -e "$HOME/.blackdogbot/config.yaml" ] || [ -e "$HOME/.blackdogbot/docker-compose.yaml" ]; then
  echo "Existing BlackDogBot install detected; refusing to overwrite it." >&2
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
TEMP="$DEST.clone.$$"
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
echo "Cloning BlackDogBot ($REF) into $DEST"
git clone --quiet --depth 1 --branch "$REF" "$REPOSITORY" "$TEMP"
mv "$TEMP" "$DEST"
trap - EXIT HUP INT TERM
echo "Starting interactive installer from downloaded Git checkout."
# The shell script itself was provided through stdin (the curl pipe);
# interactive questions must use /dev/tty, not the already-consumed pipe.
exec bash "$DEST/install.sh" </dev/tty
