#!/usr/bin/env bash
# Quick health check — returns non-zero if engine needs restart
ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_FILE="$HOME/.openclaw/data/azorean-engine-status.json"

# Check if engine process is running
if ! pgrep -f "runner.sh" > /dev/null 2>&1; then
  echo "UNHEALTHY: engine not running"
  exit 1
fi

# Check if watcher is alive
WATCHER_PID=$(python3 -c "import json; print(json.load(open('$STATUS_FILE')).get('watcher_pid', 0))" 2>/dev/null)
if [ -z "$WATCHER_PID" ] || [ "$WATCHER_PID" = "0" ] || ! kill -0 "$WATCHER_PID" 2>/dev/null; then
  echo "UNHEALTHY: watcher dead (PID: $WATCHER_PID)"
  exit 1
fi

# Check for sustained Realtime errors in last 100 lines of logs
RECENT_ERRORS=$(tail -100 "$HOME/.openclaw/logs/azorean-engine.log" | grep -c "CHANNEL_ERROR\|CLOSED.*reconnect")
if [ "$RECENT_ERRORS" -gt 10 ]; then
  echo "UNHEALTHY: $RECENT_ERRORS Realtime errors in recent logs"
  exit 1
fi

echo "HEALTHY"
exit 0
