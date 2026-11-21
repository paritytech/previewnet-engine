#!/usr/bin/env bash
# The relay's node command when the network overlay sets safeRpc: polkadot, with the RPC method
# set from PPN_RPC_METHODS in place of zombienet's `unsafe` (lib/rpc-methods.sh). Without
# safeRpc the genesis TOML runs the binary directly.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/workspace.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/rpc-methods.sh"

rpc_method_args "$@"
exec "${PPN_BIN_DIR:-${BIN:-$PPN_WS_BIN}}/${PPN_RELAY_BINARY:-polkadot}" "${NODE_ARGS[@]}"
