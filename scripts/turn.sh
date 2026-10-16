#!/usr/bin/env bash
# zombienet's custom_processes exec a command path, so this launcher has to exist.
# The logic lives in `ppn service turn` — see docs/TURN.md.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/bin/ppn.mjs"
[[ -f "$ENTRY" ]] || ENTRY="$ROOT/dist/bin.js"

# A leftover eturnal from a previous run holds the ports, or another network's relay does, or
# any other Erlang node (the old sweep killed every `beam` listener on them): refuse, naming it.
# `ppn kill` stops this workspace's own, through `ppn service turn`.
source "$ROOT/scripts/lib/workspace.sh"
source "$ROOT/config/ports.env"
[[ -f "$PPN_WS/config/ports.local.env" ]] && source "$PPN_WS/config/ports.local.env"
"$ROOT/scripts/require-free-ports.sh" "$TURN_PORT" "$TURN_PROXY_PORT" || exit 1

exec node "$ENTRY" service turn
