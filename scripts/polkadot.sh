#!/usr/bin/env bash
# The relay's node command when the network overlay sets safeRpc: polkadot, with its arguments
# rewritten by lib/safe-rpc.sh. Without safeRpc the TOML runs the binary directly.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/workspace.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/safe-rpc.sh"

rewrite_node_args "$@"
exec "$PPN_NODE_BIN_DIR/polkadot" "${NODE_ARGS[@]}"
