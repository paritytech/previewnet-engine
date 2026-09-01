#!/usr/bin/env bash
# zombienet's custom_processes spawns a command path, so this launcher has to exist.
# What it used to decide now lives in `ppn service pin-bulletin-products` — see docs/ARCHITECTURE.md.
# In a checkout the entry point is bin/ppn.mjs; installed from npm it is dist/bin.js —
# the tarball ships no bin/. Every service launcher had the checkout path hardcoded, which
# broke every custom_process on an npm install, silently: zombienet does not gate a spawn
# on its custom processes, so the network came up with cores unassigned and no services.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/bin/ppn.mjs"
[[ -f "$ENTRY" ]] || ENTRY="$ROOT/dist/bin.js"
exec node "$ENTRY" service pin-bulletin-products
