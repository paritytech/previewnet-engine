#!/usr/bin/env bash
set -euo pipefail

if command -v dot >/dev/null 2>&1; then
    echo "✓ dot CLI present"
    exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required to install dot CLI (polkadot-cli)."
    echo "Install Node.js first, then rerun: make ensure-dot-cli"
    exit 1
fi

echo "Installing dot CLI globally (polkadot-cli@latest)..."
if npm install -g polkadot-cli@latest; then
    echo "✓ dot CLI installed"
else
    echo "✗ Failed to install dot CLI"
    echo "Try running manually:"
    echo "  npm install -g polkadot-cli@latest"
    exit 1
fi
