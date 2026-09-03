#!/usr/bin/env bash
# zombienet's custom_processes spawns a command path, so this launcher has to exist.
# What it does lives in `ppn service enact-upgrades` — see docs/FORK.md.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/bin/ppn.mjs"
[[ -f "$ENTRY" ]] || ENTRY="$ROOT/dist/bin.js"
exec node "$ENTRY" service enact-upgrades
