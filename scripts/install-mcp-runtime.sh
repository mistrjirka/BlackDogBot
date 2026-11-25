#!/usr/bin/env bash
# Install the pinned, architecture-neutral Node MCP runtimes in the user's home.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 searxng|playwright" >&2
  exit 2
fi
case "$1" in
  searxng)
    package="mcp-searxng@2.10.0"
    executable="mcp-searxng"
    ;;
  playwright)
    package="@playwright/mcp@0.0.84"
    executable="playwright-mcp"
    ;;
  *)
    echo "Unknown MCP runtime: $1" >&2
    exit 2
    ;;
esac

command -v node >/dev/null || { echo "Node.js 22+ is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22+ is required, got $(node --version)" >&2
  exit 1
fi

root="${BLACKDOGBOT_MCP_ROOT:-$HOME/.local/share/blackdogbot/mcp}"
destination="$root/$1"
mkdir -p "$destination"
# --ignore-scripts prevents arbitrary dependency postinstall execution. Playwright's
# matching browser is installed separately using that exact package's CLI.
npm install --prefix "$destination" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund "$package"
binary="$destination/node_modules/.bin/$executable"
if [[ ! -x "$binary" ]]; then
  echo "MCP package is missing executable: $binary" >&2
  exit 1
fi

if [[ "$1" == "playwright" ]]; then
  playwright_cli="$destination/node_modules/playwright/cli.js"
  if [[ ! -f "$playwright_cli" ]]; then
    echo "Playwright runtime dependency is missing: $playwright_cli" >&2
    exit 1
  fi
  # Use the exact Playwright version bundled with the MCP package, not the
  # unrelated latest Playwright release. Firefox is supported on Linux arm64.
  # A dedicated cache prevents Playwright from garbage-collecting browsers
  # installed by other applications on this account.
  PLAYWRIGHT_BROWSERS_PATH="$destination/browsers" node "$playwright_cli" install firefox
fi
printf '%s\n' "$binary"
