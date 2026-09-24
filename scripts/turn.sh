#!/usr/bin/env bash
# zombienet's custom_processes exec a command path, so this launcher has to exist.
# The logic lives in `ppn service turn` — see docs/TURN.md.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/bin/ppn.mjs"
[[ -f "$ENTRY" ]] || ENTRY="$ROOT/dist/bin.js"

# A leftover eturnal from a previous run holds the ports. Listeners only: a bare `lsof -i
# :3478` also matches browsers connected to some other TURN server.
source "$ROOT/scripts/lib/workspace.sh"
source "$ROOT/config/ports.env"
[[ -f "$PPN_WS/config/ports.local.env" ]] && source "$PPN_WS/config/ports.local.env"
for port in "$TURN_PORT" "$TURN_PROXY_PORT"; do
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
done

exec node "$ENTRY" service turn
