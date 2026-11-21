#!/usr/bin/env bash
# The relay's node command when the network overlay sets safeRpc: polkadot, with its arguments
# rewritten by lib/safe-rpc.sh. Without safeRpc the TOML runs the binary directly.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/workspace.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/safe-rpc.sh"

safe_rpc_args "$@"
exec "${PPN_BIN_DIR:-${BIN:-$PPN_WS_BIN}}/polkadot" "${NODE_ARGS[@]}"
