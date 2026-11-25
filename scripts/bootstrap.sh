#!/bin/sh
# Fresh Linux installation. Published installer assets pin BLACKDOGBOT_REF.
set -eu
umask 077
REPOSITORY="https://github.com/mistrjirka/BlackDogBot.git"

checkout_source() {
  checkout_repository="$1"
  checkout_ref="$2"
  checkout_target="$3"
  case "$checkout_ref" in *[!A-Za-z0-9._/-]* | "" | -* )
    echo "Invalid BLACKDOGBOT_REF" >&2
    return 1
    ;;
  esac
  checkout_is_sha=false
  if [ "${#checkout_ref}" -eq 40 ]; then
    case "$checkout_ref" in *[!a-fA-F0-9]* ) ;; * ) checkout_is_sha=true ;; esac
  fi
  if [ "$checkout_is_sha" = true ]; then
    git init --quiet "$checkout_target"
    git -C "$checkout_target" remote add origin "$checkout_repository"
    git -C "$checkout_target" fetch --quiet --depth 1 origin "$checkout_ref"
    git -C "$checkout_target" checkout --quiet --detach FETCH_HEAD
    checkout_actual=$(git -C "$checkout_target" rev-parse HEAD)
    checkout_expected=$(printf '%s' "$checkout_ref" | tr 'A-F' 'a-f')
    if [ "$checkout_actual" != "$checkout_expected" ]; then
      echo "The fetched commit does not match BLACKDOGBOT_REF." >&2
      return 1
    fi
  else
    git clone --quiet --depth 1 --branch "$checkout_ref" "$checkout_repository" "$checkout_target"
  fi
}

latest_stable_release() {
  python3 - <<'PY'
import json
import re
import sys
import urllib.error
import urllib.request
try:
    request = urllib.request.Request(
        "https://api.github.com/repos/mistrjirka/BlackDogBot/releases/latest",
        headers={"Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2026-03-10",
                 "User-Agent": "BlackDogBot-bootstrap"})
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    tag = value.get("tag_name", "")
    if value.get("draft") or value.get("prerelease") or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("invalid stable release")
    print(tag)
except (OSError, ValueError, TypeError):
    sys.exit("Cannot resolve the latest stable release. Retry, or set BLACKDOGBOT_REF to a reviewed tag or full commit.")
PY
}

if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  echo "HOME must point to a writable user directory." >&2
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the account that will own the service, not root/sudo." >&2
  exit 1
fi
for cmd in git bash python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required; install it before running the bootstrapper." >&2
    exit 1
  fi
done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else "Python 3.9 or newer is required.")'
if ! ( : </dev/tty ) 2>/dev/null; then
  echo "Interactive install requires a terminal; run in a real shell." >&2
  exit 1
fi
DEST="${BLACKDOGBOT_SOURCE_DIR:-$HOME/.local/share/blackdogbot/source}"
case "$DEST" in /* ) ;; * ) echo "BLACKDOGBOT_SOURCE_DIR must be absolute." >&2; exit 1 ;; esac
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "Source directory already exists: $DEST" >&2
  echo "For updates use upgrade.py, not the installer." >&2
  exit 1
fi
if [ -e "$HOME/.blackdogbot/config.yaml" ] || [ -L "$HOME/.blackdogbot/config.yaml" ] ||
   [ -e "$HOME/.blackdogbot/docker-compose.yaml" ] || [ -L "$HOME/.blackdogbot/docker-compose.yaml" ]; then
  echo "Existing BlackDogBot install detected; refusing to overwrite it." >&2
  exit 1
fi
REF="${BLACKDOGBOT_REF:-}"
if [ -z "$REF" ]; then REF=$(latest_stable_release); fi
mkdir -p "$(dirname "$DEST")"
TEMP=$(mktemp -d "$DEST.clone.XXXXXXXX")
trap 'rm -rf "$TEMP"' EXIT
trap 'exit 1' HUP INT TERM
echo "Cloning BlackDogBot ($REF) into $DEST"
checkout_source "$REPOSITORY" "$REF" "$TEMP"
if [ ! -f "$TEMP/scripts/atomic-publish.py" ]; then
  echo "This source predates the safe installer. Choose v0.2.0 or newer." >&2
  exit 1
fi
python3 "$TEMP/scripts/atomic-publish.py" "$TEMP" "$DEST"
trap - EXIT HUP INT TERM
echo "Starting interactive installer from downloaded Git checkout."
exec bash "$DEST/install.sh" </dev/tty
