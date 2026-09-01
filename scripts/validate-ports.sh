#!/usr/bin/env bash
# Validates that config/ports.env matches the ports in the generated TOML from
# @ppn/network-config (source of truth, requires a build).
# Generates fresh TOML if Node.js is available; falls back to local-dev.toml otherwise.
#
# This is the engine half. The deployment half — rendering server/nginx/ppn.conf.template
# through `ppn nginx-conf` and checking every route comes out — is server/validate-nginx.sh,
# beside the template it checks, because releases carry no server/.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

ENV_FILE="$REPO_ROOT/config/ports.env"
TOML_FILE="$REPO_ROOT/zombienet-configs/local-dev.toml"

# Generate fresh TOML from source of truth (builds spawner TS if needed)
make -C "$REPO_ROOT" generate-toml

ERRORS=0

# Source the env file
if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found"
    exit 1
fi
source "$ENV_FILE"

echo "Validating port configuration..."
echo ""

# === Validate against TOML config ===
TOML_NAME=$(basename "$TOML_FILE")
echo "=== Checking $TOML_NAME ==="
if [[ ! -f "$TOML_FILE" ]]; then
    echo "ERROR: $TOML_FILE not found"
    exit 1
fi

TOML_PORTS=$(grep -E '^rpc_port\s*=' "$TOML_FILE" | grep -oE '[0-9]+' | sort -n | tr '\n' ' ' | xargs)
ENV_PORTS=$(echo "$ALL_PORTS" | tr ' ' '\n' | sort -n | tr '\n' ' ' | xargs)

if [[ "$TOML_PORTS" != "$ENV_PORTS" ]]; then
    echo "WARNING: Port mismatch with $TOML_NAME!"
    echo "  config/ports.env (ALL_PORTS): $ENV_PORTS"
    echo "  $TOML_NAME:               $TOML_PORTS"
    ERRORS=$((ERRORS + 1))
else
    echo "OK: ALL_PORTS matches $TOML_NAME"
fi
echo ""

# === Summary ===
if [[ $ERRORS -gt 0 ]]; then
    echo "FAILED: $ERRORS validation error(s) found"
    echo "Please update config/ports.env to match the configuration files"
    exit 1
fi

echo "SUCCESS: Port configuration validated"
exit 0
