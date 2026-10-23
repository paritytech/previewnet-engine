#!/usr/bin/env bash
# zombienet's custom_processes spawns a command path, so this launcher has to exist.
# The logic lives in `ppn service trinity-stack` — see docs/TRINITY-STACK.md.
# In a checkout the entry point is bin/ppn.mjs; installed from npm it is dist/bin.js.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/bin/ppn.mjs"
[[ -f "$ENTRY" ]] || ENTRY="$ROOT/dist/bin.js"
exec node "$ENTRY" service trinity-stack
