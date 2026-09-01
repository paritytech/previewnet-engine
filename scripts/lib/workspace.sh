#!/usr/bin/env bash
# Where the workspace is — the one rule, shared by every launcher. Mirrors workspaceRoot()
# in @parity/ppn-network-config: $PPN_HOME, else the nearest ancestor of the cwd with
# networks/, else a checkout this script sits in, else the per-user home. In a checkout all
# of these agree; installed from npm the script lives in node_modules, whose bin/ does not
# exist — five launchers each grew their own partial copy of this logic and each broke a
# different way, which is why it now lives here once.
#
# zombienet runs custom processes with a stripped environment (no HOME), so the last resort
# derives the home from the owner of this file — the user whose `ppn fetch` filled ~/.ppn.
#
# Usage:  source "$(dirname "${BASH_SOURCE[0]}")/lib/workspace.sh"   (adjust depth)
# Sets:   PPN_WS       the workspace root
#         PPN_WS_BIN   its bin/ (callers append /<network> for non-previewnet binaries)

ppn_workspace_root() {
    if [[ -n "${PPN_HOME:-}" ]]; then
        echo "$PPN_HOME"; return
    fi
    local dir="$PWD"
    for _ in 1 2 3 4 5 6 7 8; do
        [[ -d "$dir/networks" ]] && { echo "$dir"; return; }
        [[ "$dir" == "/" ]] && break
        dir="$(dirname "$dir")"
    done
    # A checkout: this helper sits at <root>/scripts/lib/workspace.sh, and a checkout has a
    # fetched bin/. The npm package ships scripts/ too but never a bin/, so this rung
    # distinguishes them.
    local own; own="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    [[ -d "$own/bin" ]] && { echo "$own"; return; }
    # The per-user home.
    if [[ -n "${XDG_DATA_HOME:-}" ]]; then
        echo "$XDG_DATA_HOME/ppn"; return
    fi
    if [[ -n "${HOME:-}" ]]; then
        echo "$HOME/.ppn"; return
    fi
    local owner
    owner="$(stat -c '%U' "${BASH_SOURCE[0]}" 2>/dev/null)" \
        || owner="$(stat -f '%Su' "${BASH_SOURCE[0]}" 2>/dev/null)" \
        || owner=""
    [[ "$owner" =~ ^[A-Za-z0-9._-]+$ ]] && { echo "$(eval echo "~$owner")/.ppn"; return; }
    echo ""
}

PPN_WS="$(ppn_workspace_root)"
PPN_WS_BIN="$PPN_WS/bin"
