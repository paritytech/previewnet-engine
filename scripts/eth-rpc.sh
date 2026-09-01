#!/usr/bin/env bash
# eth-rpc wrapper - connects to Asset Hub

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The package: shipped, read-only — this script and the default ports.env travel together.
PROJECT_DIR="$SCRIPT_DIR/.."

# The workspace: where `ppn fetch` puts binaries and `ppn start` writes ports.local.env. In a
# checkout it is the same directory as the package; installed from npm it is not, and reading
# either from $SCRIPT_DIR/.. would look inside node_modules for a bin/ that does not exist.
source "$(dirname "${BASH_SOURCE[0]}")/lib/workspace.sh"
WS="$PPN_WS"
BIN_DIR="$WS/bin"

# Source port configuration — the package's own default.
source "$PROJECT_DIR/config/ports.env"

# eth-rpc is network-versioned (its build must match the Asset Hub runtime's revive
# pallet), so non-previewnet networks keep it in bin/<network>. zombie-cli does not
# forward env to custom_processes; the network selector comes from the gitignored
# override file `ppn start` writes into the workspace.
[[ -f "$WS/config/ports.local.env" ]] && source "$WS/config/ports.local.env"
if [[ -n "${PPN_NETWORK:-}" && "$PPN_NETWORK" != "previewnet" ]]; then
    BIN_DIR="$WS/bin/$PPN_NETWORK"
fi

export RUST_LOG="${RUST_LOG:-info}"

# eth-rpc caches receipts and block index in a SQLite db. Its default home is
# ~/.local/share/eth-rpc, which outlives the chain: wipe the chain data, start a
# network with a different genesis, and eth-rpc finds a db from the old chain,
# fails the essential `block-subscription` task with ChainMismatch and exits —
# leaving nothing behind port 8545 until someone deletes the db by hand
# (previewnet spent 2026-08-19 to 08-20 that way). Keeping it under the chain
# data directory ties the cache's lifetime to the state it describes, so
# `make clean-data` and a clean redeploy take it with them.
# Per-mode data dir (data/ vs data-fork/), written by `ppn start` into ports.local.env —
# zombienet strips DATA_DIR from custom processes. A genesis cache read by a fork (or the
# reverse) is a different chain: eth-rpc exits with ChainMismatch on its first block.
ETH_RPC_BASE_PATH="${ETH_RPC_DATA_DIR:-${DATA_DIR:-${PPN_DATA_DIR:-$WS/data}}/eth-rpc-db}"
mkdir -p "$ETH_RPC_BASE_PATH"

exec "$BIN_DIR/eth-rpc" \
    --node-rpc-url "ws://127.0.0.1:$ASSET_HUB_PORT" \
    --base-path "$ETH_RPC_BASE_PATH"
