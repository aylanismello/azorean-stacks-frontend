#!/usr/bin/env bash
# Azorean Stacks Engine — persistent runner
# Runs discover/enrich, then spends most of the cycle draining downloads.

set -o pipefail

ENGINE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.openclaw/logs"
LOG_FILE="$LOG_DIR/azorean-engine.log"
STATUS_FILE="$HOME/.openclaw/data/azorean-engine-status.json"
MAX_LOG_LINES=10000
BUN="/opt/homebrew/bin/bun"
YT_DLP_BIN="${YT_DLP_BIN:-$(command -v yt-dlp 2>/dev/null || true)}"

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$STATUS_FILE")"

cd "$ENGINE_DIR" || exit 1

# Source environment
if [ -f "$ENGINE_DIR/.env" ]; then
  set -a
  source "$ENGINE_DIR/.env"
  set +a
fi

UPTIME_SINCE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
CYCLE_COUNT=0

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >> "$LOG_FILE"
}

truncate_log() {
  if [ -f "$LOG_FILE" ]; then
    local line_count
    line_count=$(wc -l < "$LOG_FILE")
    if [ "$line_count" -gt "$MAX_LOG_LINES" ]; then
      local tmp
      tmp=$(mktemp)
      tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "$tmp" && mv "$tmp" "$LOG_FILE"
      log "Log truncated to $MAX_LOG_LINES lines"
    fi
  fi
}

write_status() {
  local running="${1:-true}"
  cat > "$STATUS_FILE" <<EOF
{
  "running": $running,
  "last_discover_at": "$LAST_DISCOVER_AT",
  "last_download_at": "$LAST_DOWNLOAD_AT",
  "last_discover_result": $LAST_DISCOVER_RESULT,
  "last_download_result": $LAST_DOWNLOAD_RESULT,
  "uptime_since": "$UPTIME_SINCE",
  "cycle_count": $CYCLE_COUNT,
  "watcher_pid": ${WATCHER_PID:-0}
}
EOF
}

cleanup() {
  log "Runner stopping (received signal)"
  if [ -n "$WATCHER_PID" ] && [ "$WATCHER_PID" -gt 0 ] 2>/dev/null; then
    log "Stopping watcher (PID: $WATCHER_PID)"
    kill "$WATCHER_PID" 2>/dev/null
    wait "$WATCHER_PID" 2>/dev/null
  fi
  write_status "false"
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

LAST_DISCOVER_AT=""
LAST_DOWNLOAD_AT=""
LAST_DISCOVER_RESULT='{"tracks_found":"unknown","error":null}'
LAST_DOWNLOAD_RESULT='{"tracks_downloaded":"unknown","error":null}'
WATCHER_PID=0

log "=== Azorean Stacks Engine starting ==="
log "Engine directory: $ENGINE_DIR"
log "Bun: $BUN"
log "yt-dlp: ${YT_DLP_BIN:-missing}"

if [ -n "$YT_DLP_BIN" ]; then
  export YT_DLP_BIN
fi

# Spawn Realtime watcher in background
log "Starting Realtime watcher..."
"$BUN" run scripts/watcher.ts >> "$LOG_FILE" 2>&1 &
WATCHER_PID=$!
log "Watcher started (PID: $WATCHER_PID)"
write_status

while true; do
  CYCLE_COUNT=$((CYCLE_COUNT + 1))
  log "--- Cycle $CYCLE_COUNT ---"

  # Discover
  log "Running discover..."
  LAST_DISCOVER_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if output=$("$BUN" run discover 2>&1); then
    # Parse "  {N} candidates found" from discover output
    tracks_found=$(echo "$output" | grep -oE '[0-9]+ candidates found' | grep -oE '[0-9]+' | head -1)
    if [ -n "$tracks_found" ]; then
      LAST_DISCOVER_RESULT="{\"tracks_found\":${tracks_found},\"error\":null}"
    else
      LAST_DISCOVER_RESULT="{\"tracks_found\":\"unknown\",\"error\":null}"
    fi
    log "Discover completed successfully (tracks_found=$tracks_found)"
  else
    local err_line
    err_line=$(echo "$output" | tail -1 | sed 's/"/\\"/g')
    LAST_DISCOVER_RESULT="{\"tracks_found\":0,\"error\":\"$err_line\"}"
    log "Discover failed: $output"
  fi
  write_status

  # Download
  log "Running download..."
  LAST_DOWNLOAD_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if output=$("$BUN" run download --duration 25 --limit 60 2>&1); then
    # Parse "  Downloaded: {N}" from download output
    tracks_downloaded=$(echo "$output" | grep -oE 'Downloaded: [0-9]+' | grep -oE '[0-9]+' | head -1)
    if [ -n "$tracks_downloaded" ]; then
      LAST_DOWNLOAD_RESULT="{\"tracks_downloaded\":${tracks_downloaded},\"error\":null}"
    else
      LAST_DOWNLOAD_RESULT="{\"tracks_downloaded\":\"unknown\",\"error\":null}"
    fi
    log "Download completed successfully (tracks_downloaded=$tracks_downloaded)"
  else
    local err_line
    err_line=$(echo "$output" | tail -1 | sed 's/"/\\"/g')
    LAST_DOWNLOAD_RESULT="{\"tracks_downloaded\":0,\"error\":\"$err_line\"}"
    log "Download failed: $output"
  fi
  write_status

  # Truncate log periodically
  truncate_log

  log "Sleeping 5 minutes..."
  sleep 300 &
  wait $!
done
