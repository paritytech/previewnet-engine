#!/usr/bin/env bash
# Kill any process listening on the given port(s).
# Usage: kill-port.sh 8080 5001 4001

for PORT in "$@"; do
    PIDS=$(lsof -ti ":$PORT" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "Killing process(es) on port $PORT: $PIDS"
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
    fi
done
