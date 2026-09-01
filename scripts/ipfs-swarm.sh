#!/usr/bin/env bash
# IPFS swarm reconnect loop - keeps IPFS connected to Bulletin Chain

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/lib/workspace.sh"
BIN_DIR="$PPN_WS_BIN"

# Source port configuration
source "$PROJECT_DIR/config/ports.env"

IPFS_PATH="${IPFS_PATH:-$BIN_DIR/.ipfs}"
IPFS_BIN="${IPFS_BIN:-$BIN_DIR/ipfs}"

# Bulletin's peer id is derived from its node key, which zombienet derives from the
# NODE NAME — and genesis and fork spawns name the collator differently, so any
# hardcoded id only ever matches one mode (a fork's kubo retried forever and fresh
# uploads were unfetchable through the gateway). Resolve it from the collator's own
# RPC instead; re-resolving every loop also survives a collator restart.
resolve_bulletin_addr() {
    local peer
    peer=$(curl -sS --max-time 5 -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"system_localPeerId","params":[]}' \
        "http://127.0.0.1:$BULLETIN_PORT" 2>/dev/null \
        | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')
    [[ -n "$peer" ]] && echo "/ip4/127.0.0.1/tcp/$BULLETIN_P2P_PORT/ws/p2p/$peer"
}

echo "IPFS swarm reconnect loop starting..."
echo "  IPFS_PATH: $IPFS_PATH"

# Wait for IPFS daemon to start
sleep 10

while true; do
    BULLETIN_ADDR=$(resolve_bulletin_addr)
    if [[ -z "$BULLETIN_ADDR" ]]; then
        echo "Bulletin RPC (:$BULLETIN_PORT) not answering yet..."
        sleep 5
        continue
    fi
    if OUTPUT=$(IPFS_PATH="$IPFS_PATH" "$IPFS_BIN" swarm connect "$BULLETIN_ADDR" 2>&1); then
        echo "Connected to Bulletin ($BULLETIN_ADDR)"
    else
        echo "Retrying connection to $BULLETIN_ADDR: $OUTPUT"
    fi
    sleep 5
done
