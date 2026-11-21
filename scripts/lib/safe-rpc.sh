#!/usr/bin/env bash
# Node arguments under the network overlay's safeRpc (PPN_SAFE_RPC=1 on every node): RPC and
# Prometheus on localhost only, and only safe RPC methods. zombienet passes every node
# `--rpc-methods unsafe` and `--prometheus-external` and drops `--rpc-methods` from the node's own
# args, and the engine passes `--unsafe-rpc-external`, so the launcher rewrites the arguments
# itself: each side of a collator's `--` (the collator, then its relay-chain node) ends with
# `--rpc-methods safe`.
#
# Usage:  source "$(dirname "${BASH_SOURCE[0]}")/lib/safe-rpc.sh"
#         safe_rpc_args "$@"; exec <node> "${NODE_ARGS[@]}"
# Sets:   NODE_ARGS   the arguments to run the node with; unchanged without PPN_SAFE_RPC=1

safe_rpc_args() {
    if [[ "${PPN_SAFE_RPC:-}" != 1 ]]; then NODE_ARGS=("$@"); return; fi
    NODE_ARGS=()
    local arg skip_value=false
    for arg in "$@"; do
        if [[ "$skip_value" == true ]]; then skip_value=false; continue; fi
        case "$arg" in
            --rpc-methods) skip_value=true ;;
            --rpc-methods=* | --unsafe-rpc-external | --rpc-external | --prometheus-external) ;;
            --) NODE_ARGS+=(--rpc-methods safe --) ;;
            *) NODE_ARGS+=("$arg") ;;
        esac
    done
    NODE_ARGS+=(--rpc-methods safe)
}
