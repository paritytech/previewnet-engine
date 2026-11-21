#!/usr/bin/env bash
# zombienet passes every node `--rpc-methods unsafe` and drops the flag from the node's own args,
# so a launcher puts the method set a deployment asks for in its place: PPN_RPC_METHODS, set on
# every node when the network overlay has safeRpc.
#
# Usage:  source "$(dirname "${BASH_SOURCE[0]}")/lib/rpc-methods.sh"
#         rpc_method_args "$@"; exec <node> "${NODE_ARGS[@]}"
# Sets:   NODE_ARGS   the arguments, with the value after --rpc-methods replaced when asked

rpc_method_args() {
    NODE_ARGS=()
    local previous_arg=""
    for arg in "$@"; do
        if [[ "$previous_arg" == "--rpc-methods" && -n "${PPN_RPC_METHODS:-}" ]]; then
            arg="$PPN_RPC_METHODS"
        fi
        NODE_ARGS+=("$arg")
        previous_arg="$arg"
    done
}
