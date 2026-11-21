#!/usr/bin/env bash
# Node arguments under the network overlay's safeRpc (PPN_SAFE_RPC=1 on every node): RPC and
# Prometheus on localhost only, and only safe RPC methods. zombienet passes every node
# `--rpc-methods unsafe` and `--prometheus-external` and drops `--rpc-methods` from the node's own
# args, and the engine passes `--unsafe-rpc-external`, so the launcher rewrites the arguments
# itself. Each side of a collator's `--` (the collator, then its relay-chain node) gets
# `--rpc-methods safe`, whether or not zombienet passed the flag.
#
# Usage:  source "$(dirname "${BASH_SOURCE[0]}")/lib/safe-rpc.sh"
#         safe_rpc_args "$@"; exec <node> "${NODE_ARGS[@]}"
# Sets:   NODE_ARGS   the arguments to run the node with; unchanged without PPN_SAFE_RPC=1

safe_rpc_args() {
    NODE_ARGS=("$@")
    [[ "${PPN_SAFE_RPC:-}" == 1 ]] || return 0
    NODE_ARGS=()
    local previous_arg="" methods_set=false
    for arg in "$@"; do
        case "$arg" in
            --unsafe-rpc-external | --rpc-external | --prometheus-external) continue ;;
            --rpc-methods=*) arg=--rpc-methods=safe; methods_set=true ;;
            --)
                [[ "$methods_set" == true ]] || NODE_ARGS+=(--rpc-methods safe)
                methods_set=false
                ;;
        esac
        if [[ "$previous_arg" == --rpc-methods ]]; then
            arg=safe
            methods_set=true
        fi
        NODE_ARGS+=("$arg")
        previous_arg="$arg"
    done
    [[ "$methods_set" == true ]] || NODE_ARGS+=(--rpc-methods safe)
}
