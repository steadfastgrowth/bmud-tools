#!/usr/bin/env bash
# Start the B-Mud Mac relay (iMessage + Spotify + Hermes + proxy to Mini AI/STT)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"
export POCKET_TOKEN="${POCKET_TOKEN:-}"
export MINI_BRIDGE="${MINI_BRIDGE:-http://127.0.0.1:8787}"
export IMSG_BIN="${IMSG_BIN:-imsg}"
export HERMES_BIN="${HERMES_BIN:-hermes}"
export RELAY_HOST="${RELAY_HOST:-0.0.0.0}"
export RELAY_PORT="${RELAY_PORT:-8790}"
# Music: previews + Spotify Connect by default. Experimental handset match is opt-in.
export MUSIC_MATCH_FULL="${MUSIC_MATCH_FULL:-0}"

if [ -z "$POCKET_TOKEN" ]; then
  echo "Set POCKET_TOKEN to a shared secret (same value as phone Settings → Token)" >&2
  echo "  export POCKET_TOKEN='your-long-random-string'" >&2
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "python3 required" >&2
  exit 1
fi

exec python3 "$ROOT/pocket_relay.py"
