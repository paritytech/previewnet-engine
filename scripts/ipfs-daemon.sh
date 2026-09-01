#!/usr/bin/env bash
# IPFS daemon wrapper — restarts on crash, cleans up on signal

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/lib/workspace.sh"
BIN_DIR="$PPN_WS_BIN"

# Source port configuration
source "$PROJECT_DIR/config/ports.env"

export IPFS_PATH="$BIN_DIR/.ipfs"
LOCK_FILE="$IPFS_PATH/repo.lock"

# Kill any process already on IPFS ports (prevents stale daemons from blocking startup)
"$SCRIPT_DIR/kill-port.sh" "$IPFS_GATEWAY_PORT" "$IPFS_API_PORT" "$IPFS_SWARM_PORT"

IPFS_PID=""
cleanup() {
    if [ -n "$IPFS_PID" ]; then
        kill "$IPFS_PID" 2>/dev/null
        wait "$IPFS_PID" 2>/dev/null
    fi
    exit 0
}
trap cleanup INT TERM EXIT

while true; do
    # Remove stale lock if no ipfs daemon process is running
    if [ -f "$LOCK_FILE" ] && ! pgrep -f "$BIN_DIR/ipfs daemon" >/dev/null; then
        echo "Removing stale repo.lock (no running ipfs daemon found)"
        rm -f "$LOCK_FILE"
    fi

    "$BIN_DIR/ipfs" daemon &
    IPFS_PID=$!
    wait "$IPFS_PID"
    EXIT_CODE=$?
    IPFS_PID=""

    # Exit cleanly if killed by signal (128+signal)
    if [ $EXIT_CODE -gt 128 ]; then
        exit 0
    fi

    echo "IPFS daemon exited (code $EXIT_CODE), restarting in 5s..."
    sleep 5
done
