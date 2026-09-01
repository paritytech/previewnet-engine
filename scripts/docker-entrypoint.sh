#!/bin/bash
set -e

if [ "$(uname -m)" != "x86_64" ]; then
    echo "ERROR: PPN Docker mode only supports Linux x86_64."
    echo "macOS Apple Silicon is not supported — p2p networking fails under x86_64 emulation."
    echo "Use native mode instead: make start"
    exit 1
fi

echo "========================================"
echo "  PPN - Product Preview Network"
echo "========================================"
echo ""

# Clean data directory if requested
if [ "$CLEAN" = "1" ]; then
    echo "Cleaning data directory..."
    make clean-data
    echo ""
fi

# Regenerate chainspecs if requested (for custom runtime overrides)
if [ "$REGENERATE" = "1" ]; then
    echo "Regenerating chain specs..."
    make generate
    echo ""
fi

# Show persistence mode
if [ "$EPHEMERAL" = "1" ]; then
    echo "Mode: Ephemeral (data lost on stop)"
else
    echo "Mode: Persistent (DATA_DIR=${DATA_DIR:-./data})"
fi
echo ""

echo "Starting network... (this may take a few minutes)"
echo ""
echo "Endpoints will be available at:"
echo "  Relay Alice:   ws://localhost:10000"
echo "  Relay Bob:     ws://localhost:10001"
echo "  Relay Charlie: ws://localhost:10002"
echo "  Asset Hub:     ws://localhost:10020 (2s blocks)"
echo "  People Chain:  ws://localhost:10010"
echo "  Bulletin:      ws://localhost:10030"
echo "  Eth RPC:       http://localhost:8545"
echo ""
echo "========================================"
echo ""

exec make start
